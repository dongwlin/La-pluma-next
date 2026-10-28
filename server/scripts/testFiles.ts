/**
 * 服务端测试文件发现。
 *
 * `run-tests` 与 `test:coverage` 必须运行同一批测试：只认 `__tests__` 目录下的
 * `.test.ts`，跳过隐藏项、依赖与运行数据目录。两个入口共用本模块，覆盖率运行
 * 因此不会退回 Node 的默认 glob 而漏测或多测；每个测试文件仍由独立的 Node
 * 进程执行，进程隔离不变。
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';

/** 运行数据、调试输出与依赖目录不参与测试发现。 */
export const EXCLUDED_DIRECTORIES = new Set(['data', 'debug', 'node_modules']);

/**
 * 递归收集测试文件，按路径排序保证两次运行顺序一致。
 */
export async function findTestFiles(directory: string, insideTestDirectory = false): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || EXCLUDED_DIRECTORIES.has(entry.name)) continue;

    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findTestFiles(entryPath, insideTestDirectory || entry.name === '__tests__'));
    } else if (insideTestDirectory && entry.name.endsWith('.test.ts')) {
      files.push(entryPath);
    }
  }

  return files.sort();
}
