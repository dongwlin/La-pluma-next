import { readdir } from 'node:fs/promises';
import path from 'node:path';

/** 运行数据、调试输出与依赖目录不参与测试发现。 */
export const EXCLUDED_DIRECTORIES = new Set(['data', 'debug', 'node_modules']);

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
