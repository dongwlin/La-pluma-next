import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage, isDirectExecution } from './scriptSupport.ts';
import { findTestFiles } from './testFiles.ts';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONCURRENCY_ENV = 'LA_PLUMA_TEST_CONCURRENCY';
const DEFAULT_CONCURRENCY = 4;

export interface TestEntry {
  file: string;
  label: string;
}

export interface TestResult {
  entry: TestEntry;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

export type TestFileRunner = (file: string) => Promise<Omit<TestResult, 'entry'>>;

export function resolveConcurrency(
  value: string | undefined,
  parallelism: number = availableParallelism()
): number {
  const trimmed = value?.trim();
  if (!trimmed) return Math.max(1, Math.min(DEFAULT_CONCURRENCY, parallelism));
  if (!/^[1-9]\d*$/.test(trimmed)) throw new Error(`${CONCURRENCY_ENV} must be a positive integer`);
  return Number(trimmed);
}

export async function runTestFiles(
  entries: readonly TestEntry[],
  options: { concurrency: number; run: TestFileRunner; write?: (chunk: string) => void }
): Promise<TestResult[]> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('concurrency must be a positive integer');
  }

  const write = options.write ?? ((chunk: string) => { process.stdout.write(chunk); });
  const results: Array<TestResult | undefined> = new Array(entries.length);
  let next = 0;
  let flushed = 0;

  const flush = (): void => {
    while (flushed < entries.length) {
      const result = results[flushed];
      if (!result) return;
      const output = result.output.endsWith('\n') ? result.output : `${result.output}\n`;
      write(`\n▶ ${result.entry.label}\n${output}`);
      flushed += 1;
    }
  };

  const worker = async (): Promise<void> => {
    while (next < entries.length) {
      const index = next;
      next += 1;
      const entry = entries[index];
      if (!entry) return;
      const outcome = await options.run(entry.file);
      results[index] = { entry, ...outcome };
      flush();
    }
  };

  await Promise.all(Array.from({ length: Math.min(options.concurrency, entries.length) }, () => worker()));
  return results as TestResult[];
}

const runTestFile: TestFileRunner = file => new Promise(resolve => {
  const child = spawn(process.execPath, [file], {
    cwd: serverRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const append = (chunk: string): void => {
    output += chunk;
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.once('error', error => {
    resolve({ exitCode: null, signal: null, output: `${output}${error.message}\n` });
  });
  child.once('close', (exitCode, signal) => {
    resolve({ exitCode, signal, output });
  });
});

async function main(): Promise<void> {
  const testFiles = await findTestFiles(serverRoot);
  if (testFiles.length === 0) {
    console.error('No server test files found.');
    process.exitCode = 1;
    return;
  }

  let concurrency: number;
  try {
    concurrency = resolveConcurrency(process.env[CONCURRENCY_ENV]);
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
    return;
  }

  const entries = testFiles.map(file => ({ file, label: path.relative(serverRoot, file) }));
  const results = await runTestFiles(entries, { concurrency, run: runTestFile });
  const failures = results.filter(result => result.exitCode !== 0 || result.signal !== null);

  console.log(`\nTest files: ${results.length}, passed: ${results.length - failures.length}, failed: ${failures.length}`);
  console.log(`Concurrency: ${concurrency}`);

  for (const failure of failures) {
    if (failure.signal) console.error(`Test process terminated by ${failure.signal}: ${failure.entry.label}`);
  }

  if (failures.length > 0) {
    console.error(`Failed test files:\n${failures.map(failure => `- ${failure.entry.label}`).join('\n')}`);
    process.exitCode = 1;
  }
}

if (isDirectExecution(import.meta.url)) await main();
