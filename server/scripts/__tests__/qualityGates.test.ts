import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkCoverageReport, COVERAGE_EXCLUDE, COVERAGE_THRESHOLDS } from '../coverage.ts';
import { evaluateGuardrails } from '../check-guardrails.ts';
import {
  analyzeSources,
  applyBaseline,
  findImportCycles,
  layerOf,
  parseBaseline
} from '../guardrails.ts';
import type { BaselineEntry, GuardrailViolation, SourceFile } from '../guardrails.ts';
import { checkTypeScriptPin, readLockfileDependency } from '../toolchain.ts';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function source(filePath: string, text: string): SourceFile {
  return { path: filePath, source: text };
}

function rulesOf(violations: readonly GuardrailViolation[]): string[] {
  return violations.map(violation => violation.rule).sort();
}

describe('type escape hatches', () => {
  it('flags explicit any, suppression comments and assertions through any/unknown', () => {
    const violations = analyzeSources([
      source(
        'services/fixture.ts',
        [
          'const loose: any = 1;',
          '// @ts-ignore',
          'const first = loose;',
          '// @ts-expect-error',
          'const second = loose;',
          'const cast = loose as unknown as { value: number };'
        ].join('\n')
      )
    ]);

    assert.deepEqual(rulesOf(violations), [
      'double-assertion',
      'explicit-any',
      'suppression-directive',
      'suppression-directive'
    ]);
    assert.deepEqual(violations.map(violation => violation.line).sort((left, right) => left - right), [1, 2, 4, 6]);
  });

  it('does not flag the word any in comments, strings or AbortSignal.any()', () => {
    const violations = analyzeSources([
      source(
        'services/cleanFixture.ts',
        [
          '// any value here is a word, not a type',
          "const label = 'any';",
          'const signal = AbortSignal.any([new AbortController().signal]);',
          'const parsed: unknown = JSON.parse(\'{}\');',
          'export const value = typeof parsed === "object" && parsed !== null ? parsed as { key?: string } : {};',
          'export const current = signal.aborted || label.length > 0;'
        ].join('\n')
      )
    ]);

    assert.deepEqual(violations, []);
  });
});

describe('layer direction', () => {
  it('rejects lower layers importing upper layers and unlayered production files', () => {
    const violations = analyzeSources([
      source('utils/tool.ts', "import { demo } from '../services/demo.ts';\nexport const tool = demo;"),
      source('services/demo.ts', 'export const demo = 1;'),
      source('mystery.ts', 'export const mystery = true;')
    ]);

    const inversions = violations.filter(violation => violation.rule === 'layer-inversion');
    assert.equal(inversions.length, 1);
    assert.equal(inversions[0].file, 'utils/tool.ts');
    assert.match(inversions[0].message, /utils 不得依赖 services/);

    const unlayered = violations.filter(violation => violation.rule === 'unlayered-file');
    assert.deepEqual(unlayered.map(violation => violation.file), ['mystery.ts']);
  });

  it('allows the documented downward direction and skips test files', () => {
    const violations = analyzeSources([
      source('utils/tool.ts', 'export const tool = 1;'),
      source('config/defaults.ts', "import { tool } from '../utils/tool.ts';\nexport const value = tool;"),
      source('services/demo.ts', "import { tool } from '../utils/tool.ts';\nexport const demo = tool;"),
      source('routes/api.ts', "import { demo } from '../services/demo.ts';\nexport const api = demo;"),
      source('anywhere/__tests__/deep.test.ts', "import { api } from '../../routes/api.ts';\nexport const probe = api;")
    ]);

    assert.deepEqual(violations, []);
  });

  it('classifies every production directory and the entry files', () => {
    assert.equal(layerOf('app.ts'), 'entry');
    assert.equal(layerOf('server.ts'), 'entry');
    assert.equal(layerOf('utils/logger.ts'), 'utils');
    assert.equal(layerOf('config/paths.ts'), 'config');
    assert.equal(layerOf('services/agentRunService.ts'), 'services');
    assert.equal(layerOf('routes/agent.ts'), 'routes');
    assert.equal(layerOf('scripts/check-syntax.ts'), 'scripts');
    assert.equal(layerOf('mystery.ts'), undefined);
  });
});

describe('static import cycles', () => {
  it('returns the modules of a two-node cycle', () => {
    const cycles = findImportCycles([
      { from: 'services/a.ts', to: 'services/b.ts', line: 1 },
      { from: 'services/b.ts', to: 'services/a.ts', line: 2 }
    ]);

    assert.deepEqual(cycles, [['services/a.ts', 'services/b.ts']]);
  });

  it('reports the cycle through analyzeSources', () => {
    const violations = analyzeSources([
      source('services/a.ts', "import { b } from './b.ts';\nexport const a = b;"),
      source('services/b.ts', "import { a } from './a.ts';\nexport const b = a;")
    ]);

    const cycles = violations.filter(violation => violation.rule === 'import-cycle');
    assert.equal(cycles.length, 1);
    assert.match(cycles[0].message, /静态导入环/);
  });
});

describe('baseline handling', () => {
  const entry: BaselineEntry = {
    rule: 'explicit-any',
    file: 'services/fixture.ts',
    count: 2,
    reason: 'fixture reason',
    remove: 'fixture removal'
  };

  it('accepts a documented baseline and rejects unnamed or duplicate exceptions', () => {
    const baseline = parseBaseline({ version: 1, entries: [entry] });
    assert.deepEqual(baseline.entries, [entry]);

    assert.throws(() => parseBaseline({ version: 1, entries: [{ ...entry, rule: 'unknown-rule' }] }), /rule 未知/);
    assert.throws(() => parseBaseline({ version: 1, entries: [{ ...entry, reason: '  ' }] }), /缺少 reason/);
    assert.throws(() => parseBaseline({ version: 1, entries: [{ ...entry, remove: '' }] }), /缺少 remove/);
    assert.throws(() => parseBaseline({ version: 1, entries: [entry, entry] }), /重复登记/);
    assert.throws(() => parseBaseline({ version: 2, entries: [] }), /version 必须为 1/);
  });

  it('fails above the allowed count and reports entries that can be lowered', () => {
    const violation = (line: number): GuardrailViolation => ({
      rule: 'explicit-any',
      file: 'services/fixture.ts',
      line,
      message: 'fixture'
    });

    const within = applyBaseline([violation(1), violation(2)], parseBaseline({ version: 1, entries: [entry] }));
    assert.deepEqual(within.failures, []);
    assert.deepEqual(within.reductions, []);

    const above = applyBaseline([violation(1), violation(2), violation(3)], parseBaseline({ version: 1, entries: [entry] }));
    assert.deepEqual(above.failures, [
      { rule: 'explicit-any', file: 'services/fixture.ts', actual: 3, allowed: 2, lines: [1, 2, 3] }
    ]);

    const below = applyBaseline([violation(1)], parseBaseline({ version: 1, entries: [entry] }));
    assert.deepEqual(below.reductions, [
      { rule: 'explicit-any', file: 'services/fixture.ts', actual: 1, allowed: 2 }
    ]);
  });
});

describe('toolchain pin', () => {
  const lockfile = [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    configDependencies: {}',
    '',
    '  server:',
    '    devDependencies:',
    '      typescript:',
    '        specifier: 6.0.3',
    '        version: 6.0.3',
    '',
    'packages:',
    ''
  ].join('\n');

  it('reads the importer resolution from the lockfile layout', () => {
    assert.deepEqual(readLockfileDependency(lockfile, 'server', 'typescript'), {
      specifier: '6.0.3',
      version: '6.0.3'
    });
    assert.equal(readLockfileDependency(lockfile, 'server', 'eslint'), undefined);
    assert.equal(readLockfileDependency(lockfile, 'client', 'typescript'), undefined);
  });

  it('accepts matching declaration, lockfile and installed versions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'la-pluma-pin-'));
    try {
      const serverDir = path.join(root, 'server');
      await mkdir(path.join(serverDir, 'node_modules', 'typescript'), { recursive: true });
      await writeFile(path.join(serverDir, 'package.json'), JSON.stringify({
        devDependencies: { typescript: '6.0.3' }
      }));
      await writeFile(path.join(serverDir, 'node_modules', 'typescript', 'package.json'), JSON.stringify({ version: '6.0.3' }));
      await writeFile(path.join(root, 'pnpm-lock.yaml'), lockfile);

      const result = checkTypeScriptPin({ serverDir, repoRoot: root });
      assert.deepEqual(result.problems, []);
      assert.deepEqual(result.facts, {
        declared: '6.0.3',
        lockfileSpecifier: '6.0.3',
        lockfileVersion: '6.0.3',
        installedVersion: '6.0.3'
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports every drift between declaration, lockfile and installed compiler', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'la-pluma-pin-'));
    try {
      const serverDir = path.join(root, 'server');
      await mkdir(path.join(serverDir, 'node_modules', 'typescript'), { recursive: true });
      await writeFile(path.join(serverDir, 'package.json'), JSON.stringify({
        devDependencies: { typescript: '^6.0.3' }
      }));
      await writeFile(path.join(serverDir, 'node_modules', 'typescript', 'package.json'), JSON.stringify({ version: '5.9.3' }));
      await writeFile(path.join(root, 'pnpm-lock.yaml'), lockfile.replaceAll('6.0.3', '5.9.3'));

      const result = checkTypeScriptPin({ serverDir, repoRoot: root });
      assert.equal(result.problems.length, 4);
      assert.match(result.problems.join('\n'), /必须精确声明 6\.0\.3/);
      assert.match(result.problems.join('\n'), /specifier 应为 6\.0\.3/);
      assert.match(result.problems.join('\n'), /实际版本应为 6\.0\.3，实际为 5\.9\.3/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('coverage report scope', () => {
  const report = [
    'ℹ start of coverage report',
    'ℹ file        | line % | branch % | funcs %',
    'ℹ services/a.ts | 90.00 | 80.00 | 70.00',
    'ℹ all files   |  84.42 |   76.42 |   81.30',
    'ℹ end of coverage report'
  ].join('\n');

  it('reads totals from a scoped report', () => {
    assert.deepEqual(checkCoverageReport(report), {
      problems: [],
      totals: { lines: 84.42, branches: 76.42, functions: 81.3 }
    });
  });

  it('fails when test files leak into the report or the section is missing', () => {
    const leaked = report.replace('services/a.ts', 'services/__tests__/a.test.ts');
    assert.match(checkCoverageReport(leaked).problems.join('\n'), new RegExp(`despite exclude pattern`));
    assert.deepEqual(checkCoverageReport('no report here').problems, ['coverage report section not found']);
  });

  it('keeps the exclude pattern and thresholds pinned to the recorded baseline', () => {
    assert.equal(COVERAGE_EXCLUDE, '**/__tests__/**');
    assert.deepEqual(COVERAGE_THRESHOLDS, { lines: 84, branches: 76, functions: 81 });
  });

  it('flushes a large failed run before exiting so CI retains the final diagnostics', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'la-pluma-coverage-output-'));
    try {
      const scripts = path.join(root, 'scripts');
      await mkdir(scripts);
      await mkdir(path.join(root, '__tests__'));
      await mkdir(path.join(root, 'config'));
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
      for (const file of ['coverage.ts', 'testFiles.ts', 'scriptSupport.ts']) {
        await writeFile(path.join(scripts, file), await readFile(path.join(serverRoot, 'scripts', file)));
      }
      await writeFile(
        path.join(root, 'config', 'runtimeConfig.ts'),
        await readFile(path.join(serverRoot, 'config', 'runtimeConfig.ts'))
      );
      await writeFile(path.join(root, '__tests__', 'failure.test.ts'), [
        "import { it } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "it('reports the failed coverage fixture', () => {",
        "  console.log('x'.repeat(256 * 1024));",
        "  assert.fail('coverage-fixture-failure-marker');",
        '});'
      ].join('\n'));
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      delete env.NODE_V8_COVERAGE;
      const child = spawn(process.execPath, [path.join(scripts, 'coverage.ts')], {
        cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']
      });
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('coverage fixture timed out')); }, 10_000);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { output += chunk; });
        child.stderr.on('data', (chunk: string) => { output += chunk; });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); resolve({ code, output }); });
      });
      assert.equal(result.code, 1);
      assert.match(result.output, /coverage-fixture-failure-marker/);
      assert.match(result.output, /end of coverage report/);
      assert.match(result.output, /Coverage totals:/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('guardrail gate over a fixture tree', () => {
  async function createTree(sourceText: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), 'la-pluma-guardrails-'));
    const serverDir = path.join(root, 'server');
    await mkdir(path.join(serverDir, 'utils'), { recursive: true });
    await mkdir(path.join(serverDir, 'node_modules', 'typescript'), { recursive: true });
    await writeFile(path.join(serverDir, 'package.json'), JSON.stringify({ devDependencies: { typescript: '6.0.3' } }));
    await writeFile(path.join(serverDir, 'node_modules', 'typescript', 'package.json'), JSON.stringify({ version: '6.0.3' }));
    await writeFile(path.join(root, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  server:',
      '    devDependencies:',
      '      typescript:',
      '        specifier: 6.0.3',
      '        version: 6.0.3',
      ''
    ].join('\n'));
    await writeFile(path.join(serverDir, 'guardrails-baseline.json'), JSON.stringify({ version: 1, entries: [] }));
    await writeFile(path.join(serverDir, 'utils', 'fixture.ts'), sourceText);
    return root;
  }

  it('fails on a violating fixture and passes once the violation is removed', async () => {
    const failingRoot = await createTree('export const value: any = 1;\n');
    try {
      const failing = evaluateGuardrails({
        serverRoot: path.join(failingRoot, 'server'),
        repoRoot: failingRoot
      });
      assert.equal(failing.exitCode, 1);
      assert.match(failing.lines.join('\n'), /explicit-any/);
    } finally {
      await rm(failingRoot, { recursive: true, force: true });
    }

    const cleanRoot = await createTree('export const value: unknown = 1;\n');
    try {
      const clean = evaluateGuardrails({
        serverRoot: path.join(cleanRoot, 'server'),
        repoRoot: cleanRoot
      });
      assert.equal(clean.exitCode, 0);
      assert.match(clean.lines.join('\n'), /Guardrails passed/);
    } finally {
      await rm(cleanRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when the toolchain version cannot be verified', async () => {
    const root = await createTree('export const value: unknown = 1;\n');
    try {
      await rm(path.join(root, 'pnpm-lock.yaml'));
      const evaluation = evaluateGuardrails({
        serverRoot: path.join(root, 'server'),
        repoRoot: root
      });
      assert.equal(evaluation.exitCode, 1);
      assert.match(evaluation.lines.join('\n'), /工具链版本无法核对/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
