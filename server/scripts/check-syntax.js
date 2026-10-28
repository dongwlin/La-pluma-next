/**
 * JavaScript 语法检查入口（保留 .js 的工具脚本）。
 *
 * `node --check` 只解析 JavaScript，不能解析 TypeScript 的类型标注与类型擦除语法，
 * 因此本脚本无法检查已迁移的 .ts 源码，保留 .js 而非入口源码。它继续对 server/
 * 下剩余的 .js 文件逐个执行 `node --check`，新增 JS 会在进入提交前暴露语法错误；
 * .ts 的语法与类型门禁由 `scripts/typecheck.ts` 的 `tsc --noEmit` 承担。
 */
import { readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set(['node_modules', 'data', 'debug']);

function collectJavaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name)
        ? []
        : collectJavaScriptFiles(resolve(directory, entry.name));
    }
    return entry.isFile() && entry.name.endsWith('.js')
      ? [resolve(directory, entry.name)]
      : [];
  });
}

const files = collectJavaScriptFiles(rootDir);
const failures = [];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failures.push({ file: relative(rootDir, file), output: result.stderr || result.stdout });
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n${failure.file}\n${failure.output.trim()}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Syntax check passed for ${files.length} JavaScript files.`);
}
