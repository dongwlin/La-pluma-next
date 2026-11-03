import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution } from './scriptSupport.ts';
import {
  JAVASCRIPT_EXTENSIONS,
  TYPESCRIPT_EXTENSIONS,
  collectFiles,
  relativePath
} from './sourceFiles.ts';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 语法检查拒绝的 JavaScript 源文件；应始终为空。 */
export function collectJavaScriptSources(rootDir: string): string[] {
  return collectFiles(rootDir, JAVASCRIPT_EXTENSIONS).sort();
}

export function checkSyntax(files: string[]): Array<{ file: string; output: string }> {
  const failures: Array<{ file: string; output: string }> = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      failures.push({ file, output: result.stderr || result.stdout });
    }
  }
  return failures;
}

if (isDirectExecution(import.meta.url)) {
  const javaScriptSources = collectJavaScriptSources(serverRoot);
  if (javaScriptSources.length > 0) {
    console.error('JavaScript sources are not covered by the type gate; migrate them to TypeScript:');
    for (const file of javaScriptSources) console.error(`  ${relativePath(serverRoot, file)}`);
    process.exitCode = 1;
  }

  const typeScriptFiles = collectFiles(serverRoot, TYPESCRIPT_EXTENSIONS).sort();
  if (typeScriptFiles.length === 0) {
    console.error('Syntax check scope is empty: no TypeScript files found under server/.');
    process.exitCode = 1;
  } else {
    const failures = checkSyntax(typeScriptFiles);
    if (failures.length > 0) {
      for (const failure of failures) {
        console.error(`\n${relativePath(serverRoot, failure.file)}\n${failure.output.trim()}`);
      }
      process.exitCode = 1;
    } else if (process.exitCode === undefined) {
      console.log(`Syntax check passed for ${typeScriptFiles.length} TypeScript files.`);
    }
  }
}
