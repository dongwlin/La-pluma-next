/**
 * 从 GitHub 下载 MaaResource 资源文件并更新到 MAA 目录
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage, isDirectExecution } from './scriptSupport.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// GitHub 仓库信息
const REPO_URL = 'https://github.com/MaaAssistantArknights/MaaResource.git';

/** 临时克隆目录：位于 server/ 下，与运行数据分开。 */
export const TEMP_DIR = path.join(__dirname, '../.temp-maa-resource');

/** 查询 MAA 数据目录的命令。 */
export const MAA_DATA_DIR_COMMAND = 'maa dir data';

/** 同步执行命令并返回去除首尾空白的输出。 */
export type RunCommand = (command: string) => string;

const runCommand: RunCommand = command => execSync(command, { encoding: 'utf-8' }).trim();

/** 获取 MAA 资源目录路径。 */
export function getMaaResourceDir(run: RunCommand = runCommand): string {
  try {
    // 执行 maa dir data 获取数据目录
    const dataDir = run(MAA_DATA_DIR_COMMAND);
    if (!dataDir) {
      throw new Error(`${MAA_DATA_DIR_COMMAND} 未返回数据目录`);
    }
    // 资源目录在数据目录的 resource 子目录
    const resourceDir = path.join(dataDir, 'resource');

    console.log(`MAA 资源目录: ${resourceDir}`);
    return resourceDir;
  } catch (error) {
    throw new Error(`无法获取 MAA 资源目录: ${errorMessage(error)}`);
  }
}

/** 复制目录（递归）。 */
export function copyDir(src: string, dest: string): void {
  // 确保目标目录存在
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** 删除目录（递归）。 */
export function removeDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 测试与手工运行可替换的副作用端口。 */
export interface UpdateResourcesDeps {
  run?: RunCommand;
  clone?: (command: string) => void;
  tempDir?: string;
}

/** 更新资源文件。 */
export async function updateResources(deps: UpdateResourcesDeps = {}): Promise<void> {
  const run = deps.run ?? runCommand;
  const clone = deps.clone ?? ((command: string) => {
    execSync(command, { stdio: 'inherit' });
  });
  const tempDir = deps.tempDir ?? TEMP_DIR;

  console.log('开始更新 MAA 资源文件...\n');

  try {
    // 获取 MAA 资源目录
    const resourceDir = getMaaResourceDir(run);

    if (!fs.existsSync(resourceDir)) {
      throw new Error(`MAA 资源目录不存在: ${resourceDir}`);
    }

    // 清理临时目录
    console.log('清理临时目录...');
    removeDir(tempDir);

    // 克隆仓库（只克隆最新的提交，节省时间和空间）
    console.log('从 GitHub 下载资源文件...');
    console.log(`仓库: ${REPO_URL}`);

    try {
      clone(`git clone --depth 1 --single-branch --branch main "${REPO_URL}" "${tempDir}"`);
    } catch (error) {
      throw new Error(`Git 克隆失败: ${errorMessage(error)}`);
    }

    // 检查 resource 目录是否存在
    const sourceResourceDir = path.join(tempDir, 'resource');
    if (!fs.existsSync(sourceResourceDir)) {
      throw new Error(`下载的仓库中没有 resource 目录`);
    }

    // 复制资源文件
    console.log('\n复制资源文件到 MAA 目录...');
    copyDir(sourceResourceDir, resourceDir);

    // 清理临时目录
    console.log('\n清理临时文件...');
    removeDir(tempDir);

    console.log('\n✓ 资源文件更新成功！');
  } catch (error) {
    // 清理临时目录
    removeDir(tempDir);
    throw error;
  }
}

if (isDirectExecution(import.meta.url)) {
  updateResources().catch((error: unknown) => {
    console.error('\n✗ 更新失败:', errorMessage(error));
    process.exit(1);
  });
}
