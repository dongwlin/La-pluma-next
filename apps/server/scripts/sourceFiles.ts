import { readdirSync } from 'node:fs';
import path from 'node:path';

/** 依赖、运行数据与调试输出不属于源码范围。 */
export const IGNORED_DIRECTORIES = new Set(['node_modules', 'data', 'debug']);

export const TYPESCRIPT_EXTENSIONS = ['.ts'] as const;

/** 这些扩展名会被 Node 直接运行，但类型门禁看不到。 */
export const JAVASCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs'] as const;

export function collectFiles(rootDir: string, extensions: readonly string[]): string[] {
  const files: string[] = [];
  const allowed = new Set(extensions);

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name)) continue;

      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile() && [...allowed].some(extension => entry.name.endsWith(extension))) {
        files.push(entryPath);
      }
    }
  };

  walk(rootDir);
  return files;
}

/** 统一使用 POSIX 分隔符，保证报告、基线文件与跨平台输出一致。 */
export function relativePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join('/');
}
