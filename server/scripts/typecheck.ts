import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { isDirectExecution } from './scriptSupport.ts';
import {
  JAVASCRIPT_EXTENSIONS,
  TYPESCRIPT_EXTENSIONS,
  collectFiles,
  relativePath
} from './sourceFiles.ts';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 用 tsconfig 的 include/exclude 解析程序范围，返回未被 tsc 纳入的源文件。 */
function findFilesOutsideTypeCheck(rootDir: string, collected: readonly string[]): string[] {
  const configPath = path.join(rootDir, 'tsconfig.json');
  const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
  if (readResult.error) {
    throw new Error(ts.flattenDiagnosticMessageText(readResult.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(readResult.config, ts.sys, rootDir);
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
  }

  const programFiles = new Set(parsed.fileNames.map(fileName => path.resolve(fileName)));
  return collected
    .filter(fileName => !programFiles.has(path.resolve(fileName)))
    .map(fileName => relativePath(rootDir, fileName));
}

/**
 * 类型门禁：以仓库固定的 TypeScript 版本对全部服务端 `.ts` 执行 `tsc --noEmit`。
 *
 * 服务端已没有 `allowJs` 过渡：源码目录里若出现 `.js` / `.mjs` / `.cjs`，Node 会
 * 直接运行它们但 tsc 看不到，因此这里先失败，避免“tsc 全绿”掩盖未检查范围。
 * 同时用 tsconfig 的 include/exclude 复核程序范围：新增的 TS 文件若被配置排除，
 * 会在此列出并失败，而不是计入“已检查”清单。
 */
function run(): void {
  const typeScriptFiles = collectFiles(rootDir, TYPESCRIPT_EXTENSIONS).sort();
  const javaScriptFiles = collectFiles(rootDir, JAVASCRIPT_EXTENSIONS).sort();

  if (javaScriptFiles.length > 0) {
    console.error('JavaScript sources are outside the type gate; migrate them to TypeScript:');
    for (const file of javaScriptFiles) console.error(`  ${relativePath(rootDir, file)}`);
    process.exitCode = 1;
    return;
  }

  if (typeScriptFiles.length === 0) {
    console.error('Type check scope is empty: no TypeScript files found under server/.');
    process.exitCode = 1;
    return;
  }

  let outsideScope: string[];
  try {
    outsideScope = findFilesOutsideTypeCheck(rootDir, typeScriptFiles);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (outsideScope.length > 0) {
    console.error('TypeScript files are outside the tsconfig include and would stay unchecked:');
    for (const file of outsideScope) console.error(`  ${file}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Type check scope: ${typeScriptFiles.length} TypeScript file(s), no unchecked JavaScript sources.`);
  for (const file of typeScriptFiles) {
    console.log(`  ${relativePath(rootDir, file)}`);
  }

  // 使用服务端本地安装的编译器，保证门禁版本与 package.json / 锁文件一致。
  const tscEntry = path.resolve(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tscEntry, '--noEmit', '-p', rootDir], {
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(result.error.message);
    process.exitCode = 1;
  } else if (result.signal) {
    console.error(`Type check terminated by ${result.signal}.`);
    process.exitCode = 1;
  } else if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}

if (isDirectExecution(import.meta.url)) {
  run();
}
