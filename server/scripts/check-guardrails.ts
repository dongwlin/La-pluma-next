/**
 * 服务端质量护栏入口。
 *
 * 依次核对 TypeScript 版本三处一致，再分析类型逃生舱（any / 抑制指令 / 双重断言）、
 * 分层方向、未归层文件与静态导入环，并用 `guardrails-baseline.json` 解释存量例外。
 * 只做静态事实判断，不启动服务端、不执行测试；行为回归仍由 `test` 与 `test:coverage`
 * 负责。规则边界与例外格式见 server/AGENTS.md。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyBaseline,
  collectServerSources,
  analyzeSources,
  parseBaseline
} from './guardrails.ts';
import type {
  BaselineFailure,
  BaselineReduction,
  GuardrailViolation,
  GuardrailsBaseline
} from './guardrails.ts';
import { isDirectExecution } from './scriptSupport.ts';
import { checkTypeScriptPin } from './toolchain.ts';

const defaultServerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface GuardrailsRunOptions {
  serverRoot: string;
  repoRoot: string;
  baselinePath?: string;
}

export interface GuardrailsEvaluation {
  exitCode: number;
  lines: string[];
  violations: GuardrailViolation[];
  failures: BaselineFailure[];
  reductions: BaselineReduction[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 读取并校验基线文件；文件缺失或结构错误按失败处理。 */
function loadBaseline(baselinePath: string): GuardrailsBaseline {
  const raw: unknown = JSON.parse(readFileSync(baselinePath, 'utf8'));
  return parseBaseline(raw);
}

/** 执行全部护栏检查，返回退出码与可直接打印的报告行。 */
export function evaluateGuardrails(options: GuardrailsRunOptions): GuardrailsEvaluation {
  const lines: string[] = [];
  const pinProblems: string[] = [];

  try {
    const pin = checkTypeScriptPin({ serverDir: options.serverRoot, repoRoot: options.repoRoot });
    lines.push(
      `TypeScript pin: declared ${pin.facts.declared ?? 'missing'}, ` +
        `lockfile ${pin.facts.lockfileSpecifier ?? 'missing'} -> ${pin.facts.lockfileVersion ?? 'missing'}, ` +
        `installed ${pin.facts.installedVersion ?? 'missing'}.`
    );
    pinProblems.push(...pin.problems);
  } catch (error) {
    lines.push(`TypeScript pin: cannot verify (${errorMessage(error)}).`);
    pinProblems.push('工具链版本无法核对；缺少 package.json、pnpm-lock.yaml 或安装依赖时按失败处理');
  }
  for (const problem of pinProblems) lines.push(`✗ ${problem}`);

  const baselinePath = options.baselinePath ?? path.join(options.serverRoot, 'guardrails-baseline.json');
  let baseline: GuardrailsBaseline;
  try {
    baseline = loadBaseline(baselinePath);
  } catch (error) {
    lines.push(`✗ guardrails baseline 无效（${baselinePath}）：${errorMessage(error)}`);
    lines.push('Guardrails failed.');
    return { exitCode: 1, lines, violations: [], failures: [], reductions: [] };
  }

  const sources = collectServerSources(options.serverRoot);
  const violations = analyzeSources(sources);
  const { failures, reductions } = applyBaseline(violations, baseline);

  const baselineCount = baseline.entries.reduce((total, entry) => total + entry.count, 0);
  lines.push(
    `Guardrail scope: ${sources.length} TypeScript file(s), ${violations.length} occurrence(s), ` +
      `baseline allows ${baselineCount} in ${baseline.entries.length} file rule(s).`
  );

  const failingKeys = new Set(failures.map(failure => `${failure.rule}\u0000${failure.file}`));
  for (const failure of failures) {
    lines.push(
      `✗ [${failure.rule}] ${failure.file}: ${failure.actual} occurrence(s), ` +
        `baseline allows ${failure.allowed} (lines ${failure.lines.join(', ')})`
    );
    for (const violation of violations) {
      if (`${violation.rule}\u0000${violation.file}` !== `${failure.rule}\u0000${failure.file}`) continue;
      lines.push(`    ${violation.file}:${violation.line} ${violation.message}`);
    }
  }

  for (const reduction of reductions) {
    lines.push(
      `ℹ [${reduction.rule}] ${reduction.file}: ${reduction.actual} occurrence(s), ` +
        `baseline still allows ${reduction.allowed}; lower or remove the entry`
    );
  }

  const exitCode = pinProblems.length > 0 || failures.length > 0 ? 1 : 0;
  lines.push(exitCode === 0 ? 'Guardrails passed.' : 'Guardrails failed.');
  return { exitCode, lines, violations, failures, reductions };
}

if (isDirectExecution(import.meta.url)) {
  const evaluation = evaluateGuardrails({
    serverRoot: defaultServerRoot,
    repoRoot: path.resolve(defaultServerRoot, '..')
  });
  for (const line of evaluation.lines) {
    if (line.startsWith('✗') || line.startsWith('Guardrails failed.') || line.startsWith('ℹ')) {
      console.error(line);
    } else {
      console.log(line);
    }
  }
  process.exitCode = evaluation.exitCode;
}
