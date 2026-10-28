import { readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set(['node_modules', 'data', 'debug']);

/** 递归收集指定扩展名的文件，排除运行数据与依赖目录。 */
function collectFiles(directory: string, extension: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name)
        ? []
        : collectFiles(resolve(directory, entry.name), extension);
    }
    return entry.isFile() && entry.name.endsWith(extension)
      ? [resolve(directory, entry.name)]
      : [];
  });
}

const typeScriptFiles = collectFiles(rootDir, '.ts').sort();
const javaScriptFiles = collectFiles(rootDir, '.js').sort();

if (typeScriptFiles.length === 0) {
  console.error('Type check scope is empty: no TypeScript files found under server/.');
  process.exitCode = 1;
} else {
  console.log(
    `Type check scope: ${typeScriptFiles.length} TypeScript file(s) checked, ` +
      `${javaScriptFiles.length} JavaScript file(s) in the program but not type-checked (allowJs transition).`,
  );
  console.log('Checked TypeScript files:');
  for (const file of typeScriptFiles) {
    console.log(`  ${relative(rootDir, file)}`);
  }
  console.log('Unchecked JavaScript files:');
  for (const file of javaScriptFiles) {
    console.log(`  ${relative(rootDir, file)}`);
  }

  const tscEntry = resolve(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');
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
    process.exitCode = result.status;
  }
}
