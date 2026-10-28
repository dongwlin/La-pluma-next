/**
 * 服务端源码范围：类型门禁、语法检查与质量护栏共用的文件发现规则。
 *
 * 忽略依赖、运行数据与调试输出目录以及隐藏项，避免把 `data/` 下的运行产物或
 * 编辑器临时文件当成源码。返回绝对路径，由调用方决定如何展示相对路径。
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';

/** 依赖、运行数据与调试输出不属于源码范围。 */
export const IGNORED_DIRECTORIES = new Set(['node_modules', 'data', 'debug']);

/** 类型门禁与语法检查只认 TypeScript 源。 */
export const TYPESCRIPT_EXTENSIONS = ['.ts'] as const;

/** 这些扩展名会被 Node 直接运行，但类型门禁看不到。 */
export const JAVASCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs'] as const;

/** 递归收集指定扩展名的文件，结果未排序，由调用方决定顺序。 */
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
