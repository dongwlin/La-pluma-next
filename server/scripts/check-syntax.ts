/**
 * 服务端语法检查入口。
 *
 * 服务端源码全部为 TypeScript；Node 24 的类型擦除让 `node --check` 可以直接解析
 * `.ts`，并顺带拒绝 `enum`、`namespace` 等不可擦除语法。本脚本逐个文件启动独立
 * 进程，不依赖 TypeScript 编译器，因此 `build` 在只安装生产依赖时也能运行。
 *
 * 同时拒绝 `server/` 下残留的 `.js` / `.mjs` / `.cjs` 源码：Node 会直接运行它们，
 * 但类型门禁与质量护栏都看不到，等于绕过检查。工具配置若确实只能写成 JavaScript，
 * 需要在这里登记并说明理由，不能默默放入源码目录。
 */

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

/** 逐个文件运行 `node --check`，返回失败项与其输出。 */
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
