import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTestFiles } from './testFiles.ts';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 逐文件、逐进程执行测试：发现规则见 `testFiles.ts`，每个测试文件交给独立的
 * Node 进程，避免模块单例与环境变量在文件之间相互污染。
 */
const testFiles = await findTestFiles(serverRoot);
if (testFiles.length === 0) {
  console.error('No server test files found.');
  process.exitCode = 1;
} else {
  const failures: string[] = [];

  for (const testFile of testFiles) {
    const relativePath = path.relative(serverRoot, testFile);
    console.log(`\n▶ ${relativePath}`);

    const result = spawnSync(process.execPath, [testFile], {
      cwd: serverRoot,
      env: process.env,
      stdio: 'inherit',
    });

    if (result.error || result.status !== 0) {
      failures.push(relativePath);
      if (result.error) console.error(result.error.message);
      if (result.signal) console.error(`Test process terminated by ${result.signal}.`);
    }
  }

  const passed = testFiles.length - failures.length;
  console.log(`\nTest files: ${testFiles.length}, passed: ${passed}, failed: ${failures.length}`);

  if (failures.length > 0) {
    console.error(`Failed test files:\n${failures.map(file => `- ${file}`).join('\n')}`);
    process.exitCode = 1;
  }
}
