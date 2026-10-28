/**
 * 工具链版本一致性检查。
 *
 * 服务端类型门禁固定 TypeScript 6.0.3，三处必须一致：`server/package.json` 的
 * 精确声明（不带 `^` / `~`）、根 `pnpm-lock.yaml` 中 server importer 的解析值、
 * 以及 `typecheck` 实际调用的服务端本地编译器版本。任何一处漂移都会让“编译器版本
 * 固定”失去意义，因此这里失败而不是警告。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** 全仓固定的 TypeScript 版本。 */
export const EXPECTED_TYPESCRIPT_VERSION = '6.0.3';

export interface LockfileDependency {
  specifier?: string;
  version?: string;
}

export interface TypeScriptPinFacts {
  declared?: string;
  lockfileSpecifier?: string;
  lockfileVersion?: string;
  installedVersion?: string;
}

export interface TypeScriptPinResult {
  facts: TypeScriptPinFacts;
  problems: string[];
}

/**
 * 读取 pnpm-lock.yaml 中某个 workspace importer 下的一条依赖声明。
 *
 * pnpm v9 锁文件的 importers 段落按固定缩进展开：importer 2 空格、依赖分组
 * 4 空格、依赖名 6 空格、`specifier` / `version` 8 空格。这里按缩进解析该段落，
 * 不引入 YAML 依赖；段落缺失时返回 undefined，由调用方按“无法核对”失败。
 */
export function readLockfileDependency(
  lockfileText: string,
  importer: string,
  dependency: string
): LockfileDependency | undefined {
  const lines = lockfileText.split('\n');
  const importerHeader = `  ${importer}:`;
  const startIndex = lines.findIndex(line => line === importerHeader);
  if (startIndex < 0) return undefined;

  let inDependencySection = false;
  let currentDependency: string | undefined;
  let result: LockfileDependency | undefined;

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;

    const importerIndent = line.length - line.trimStart().length;
    if (importerIndent <= 2) break;

    if (importerIndent === 4) {
      inDependencySection = line.trim() === 'dependencies:' || line.trim() === 'devDependencies:';
      currentDependency = undefined;
      continue;
    }
    if (!inDependencySection) continue;

    if (importerIndent === 6) {
      currentDependency = line.trim().replace(/:$/, '');
      if (currentDependency === dependency) result = {};
      continue;
    }
    if (currentDependency !== dependency || !result) continue;

    if (importerIndent === 8) {
      const match = /^(specifier|version):\s*(.+)$/.exec(line.trim());
      if (!match) continue;
      if (match[1] === 'specifier') result.specifier = match[2];
      else result.version = match[2];
    }
  }

  return result;
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/** 核对三处 TypeScript 版本；`problems` 为空才表示一致。 */
export function checkTypeScriptPin({ serverDir, repoRoot }: { serverDir: string; repoRoot: string }): TypeScriptPinResult {
  const problems: string[] = [];
  const facts: TypeScriptPinFacts = {};

  const packageJson = readJson(path.join(serverDir, 'package.json'));
  if (typeof packageJson === 'object' && packageJson !== null) {
    const devDependencies = (packageJson as { devDependencies?: Record<string, string> }).devDependencies;
    facts.declared = devDependencies?.typescript;
  }
  if (facts.declared !== EXPECTED_TYPESCRIPT_VERSION) {
    problems.push(
      `server/package.json devDependencies.typescript 必须精确声明 ${EXPECTED_TYPESCRIPT_VERSION}，实际为 ${facts.declared ?? '缺失'}`
    );
  }

  const lockfileText = readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
  const locked = readLockfileDependency(lockfileText, 'server', 'typescript');
  facts.lockfileSpecifier = locked?.specifier;
  facts.lockfileVersion = locked?.version;
  if (!locked) {
    problems.push('pnpm-lock.yaml 中找不到 server importer 的 typescript 解析值');
  } else {
    if (locked.specifier !== EXPECTED_TYPESCRIPT_VERSION) {
      problems.push(
        `pnpm-lock.yaml server importer 的 typescript specifier 应为 ${EXPECTED_TYPESCRIPT_VERSION}，实际为 ${locked.specifier ?? '缺失'}`
      );
    }
    if (locked.version !== EXPECTED_TYPESCRIPT_VERSION) {
      problems.push(
        `pnpm-lock.yaml server importer 的 typescript version 应为 ${EXPECTED_TYPESCRIPT_VERSION}，实际为 ${locked.version ?? '缺失'}`
      );
    }
  }

  try {
    const installed = readJson(path.join(serverDir, 'node_modules', 'typescript', 'package.json'));
    facts.installedVersion = typeof installed === 'object' && installed !== null
      ? (installed as { version?: string }).version
      : undefined;
  } catch {
    facts.installedVersion = undefined;
  }
  if (facts.installedVersion !== EXPECTED_TYPESCRIPT_VERSION) {
    problems.push(
      `server/node_modules/typescript 实际版本应为 ${EXPECTED_TYPESCRIPT_VERSION}，实际为 ${facts.installedVersion ?? '未安装'}`
    );
  }

  return { facts, problems };
}
