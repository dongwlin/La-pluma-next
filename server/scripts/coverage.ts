/**
 * 覆盖率门禁：固定测试集合、统计范围与阈值。
 *
 * - 测试集合来自 `testFiles.ts`，与 `run-tests` 完全一致；每个文件由 Node 测试
 *   运行器放进独立子进程，`--test-concurrency=1` 保持逐文件串行，进程隔离不变。
 * - 统计范围固定为服务端 TypeScript 源，测试与 fixture 目录不进入报告；脚本会
 *   在运行后复核报告，排除规则失效时直接失败，而不是悄悄把测试代码算进覆盖率。
 * - 阈值是渐进下限：以领取基线的实测值为依据向下取整，覆盖率上升后只上调；
 *   需要下调必须在评审中说明原因，不能为通过某次改动而降低。
 * - 已知限制：Node 只统计被测试加载过的文件，未被任何测试导入的模块不会出现在
 *   报告里；覆盖率因此不能替代行为测试，关键失败分支仍按契约补用例。
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution } from './scriptSupport.ts';
import { findTestFiles } from './testFiles.ts';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 统计范围：服务端全部 TypeScript 源。 */
export const COVERAGE_INCLUDE = '**/*.ts';

/** 测试与 fixture 不计入覆盖率，也不允许出现在报告里。 */
export const COVERAGE_EXCLUDE = '**/__tests__/**';

/**
 * 渐进阈值（百分比整数）。同一范围内实测：领取基线 line 84.42 / branch 76.42 /
 * funcs 81.30，补齐智能养成失败分支与门禁自身用例后为 line 84.90 / branch 76.61 /
 * funcs 81.80；阈值取整为 84 / 76 / 81，后续只升不降。
 */
export const COVERAGE_THRESHOLDS = {
  lines: 84,
  branches: 76,
  functions: 81
} as const;

export interface CoverageTotals {
  lines: number;
  branches: number;
  functions: number;
}

/**
 * 在覆盖率报告段落中核对范围并读取总计行。
 * 报告缺失、包含测试目录或缺少总计行都视为失败，避免范围变化被忽略。
 */
export function checkCoverageReport(output: string): { problems: string[]; totals: CoverageTotals | null } {
  const start = output.indexOf('start of coverage report');
  const end = output.indexOf('end of coverage report');
  if (start < 0 || end < 0 || end <= start) {
    return { problems: ['coverage report section not found'], totals: null };
  }

  const report = output.slice(start, end);
  const problems: string[] = [];
  if (report.includes('__tests__')) {
    problems.push(`coverage report still contains test files despite exclude pattern ${COVERAGE_EXCLUDE}`);
  }

  const totalsLine = /all files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)/.exec(report);
  if (!totalsLine) {
    problems.push('coverage totals row not found');
    return { problems, totals: null };
  }

  return {
    problems,
    totals: {
      lines: Number(totalsLine[1]),
      branches: Number(totalsLine[2]),
      functions: Number(totalsLine[3])
    }
  };
}

if (isDirectExecution(import.meta.url)) {
  const testFiles = await findTestFiles(serverRoot);
  if (testFiles.length === 0) {
    console.error('No server test files found.');
    process.exit(1);
  }

  console.log(
    `Coverage scope: ${COVERAGE_INCLUDE} excluding ${COVERAGE_EXCLUDE}; ` +
      `thresholds lines>=${COVERAGE_THRESHOLDS.lines}, branches>=${COVERAGE_THRESHOLDS.branches}, ` +
      `functions>=${COVERAGE_THRESHOLDS.functions}; ${testFiles.length} test file(s) run serially in isolated processes.`
  );

  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-concurrency=1',
      '--experimental-test-coverage',
      `--test-coverage-include=${COVERAGE_INCLUDE}`,
      `--test-coverage-exclude=${COVERAGE_EXCLUDE}`,
      `--test-coverage-lines=${COVERAGE_THRESHOLDS.lines}`,
      `--test-coverage-branches=${COVERAGE_THRESHOLDS.branches}`,
      `--test-coverage-functions=${COVERAGE_THRESHOLDS.functions}`,
      ...testFiles.map(file => path.relative(serverRoot, file).split(path.sep).join('/'))
    ],
    { cwd: serverRoot, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  const output = result.stdout ?? '';
  process.stdout.write(output);
  if (result.stderr) process.stderr.write(result.stderr);

  const { problems, totals } = checkCoverageReport(output);
  for (const problem of problems) console.error(problem);

  if (totals) {
    console.log(
      `Coverage totals: lines ${totals.lines.toFixed(2)}%, branches ${totals.branches.toFixed(2)}%, ` +
        `functions ${totals.functions.toFixed(2)}%.`
    );
  }

  if (result.signal) {
    console.error(`Coverage run terminated by ${result.signal}.`);
    process.exit(1);
  }
  if (problems.length > 0) process.exit(1);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
