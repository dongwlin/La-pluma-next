import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution } from './scriptSupport.ts';
import { findTestFiles } from './testFiles.ts';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const COVERAGE_INCLUDE = '**/*.ts';

export const COVERAGE_EXCLUDE = '**/__tests__/**';

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

async function main(): Promise<number> {
  const testFiles = await findTestFiles(serverRoot);
  if (testFiles.length === 0) {
    console.error('No server test files found.');
    return 1;
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
    return 1;
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
    return 1;
  }
  if (problems.length > 0) return 1;
  return result.status ?? 1;
}

if (isDirectExecution(import.meta.url)) {
  // 失败时也让 stdout/stderr 自然排空，保留报告末尾的真实错误与覆盖率汇总。
  process.exitCode = await main();
}
