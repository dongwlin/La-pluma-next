/**
 * 预览运行时资源：只支持上游发布包的 linux/darwin amd64/arm64，其余平台在取路径前抛
 * `WEBRTC_UNSUPPORTED_PLATFORM`。安装按固定 SHA-256 校验、先做布局校验再触碰既有运行
 * 目录；升级用同文件系统 rename 做事务性切换，任一步失败回滚且总是清理临时区。
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const RELEASE_VERSION = 'v0.4.3';
const RELEASE_URL = `https://github.com/hqw700/ScrcpyOverWebRTC/releases/download/${RELEASE_VERSION}/cloudphone-${RELEASE_VERSION}.zip`;
const RELEASE_SHA256 = '5fd5ea12d4ab1645db13d46fbefcceff8d4d94401a347509cd8a79f005e6c4d0';
/** 安装成功后写入运行目录的版本标记；缺失或损坏按未知旧版本处理，触发升级。 */
export const WEBRTC_RUNTIME_MARKER_FILENAME = 'la-pluma-runtime.json';

/** 网卡条目只读取地址、掩码、协议族与内部标记；`os.networkInterfaces()` 与测试替身都满足。 */
export interface WebrtcNetworkInterface {
  address: string;
  netmask?: string | null;
  family: string | number;
  internal: boolean;
}

export type WebrtcNetworkInterfaceMap = Readonly<
  Record<string, readonly WebrtcNetworkInterface[] | undefined>
>;

/** 带稳定错误码的运行时错误；`retryable` 只在调用方需要区分临时失败时提供。 */
export interface WebrtcRuntimeError extends Error {
  code: string;
  retryable?: boolean;
  cause?: unknown;
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

/**
 * 解析上游发布包中的本机二进制路径。
 *
 * 不在支持列表内的平台/架构属于确定失败：调用方不应继续探测文件或启动子进程。
 */
export function getWebrtcRuntimeBinary(
  dir: string,
  platform: string = process.platform,
  arch: string = process.arch
): string {
  const releaseArch = ({ x64: 'amd64', arm64: 'arm64' } as Record<string, string>)[arch];
  if (!['linux', 'darwin'].includes(platform) || !releaseArch) {
    const error = new Error(`WebRTC 预览暂不支持此系统架构：${platform}/${arch}`) as WebrtcRuntimeError;
    error.code = 'WEBRTC_UNSUPPORTED_PLATFORM';
    throw error;
  }
  return path.join(dir, 'bin', `${platform}_${releaseArch}`, 'webrtc-signaling');
}

/** 发布包布局校验失败的稳定错误码；安装器据此拒绝坏包而不触碰既有运行目录。 */
export const WEBRTC_RELEASE_LAYOUT_INVALID = 'WEBRTC_RELEASE_LAYOUT_INVALID';

interface WebrtcLayoutRequirement {
  label: string;
  path: string;
  present: boolean;
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 校验发布包解压产物的布局：平台二进制、静态资源入口与设备端部署脚本必须
 * 真实存在。静态资源入口与 `webrtcService.getWebrtcAssetsPath` 的识别保持
 * 一致（旧版 `assets/v1` 目录或 `assets/index.html`）。调用方必须在停止既有
 * 预览资源与写入任何文件之前完成校验，坏包才会被原样拒绝。
 */
export async function validateWebrtcReleaseLayout(extractedDir: string): Promise<void> {
  const binaryPath = getWebrtcRuntimeBinary(extractedDir);
  const assetsIndexPath = path.join(extractedDir, 'assets', 'index.html');
  const legacyAssetsPath = path.join(extractedDir, 'assets', 'v1');
  const runScriptPath = path.join(extractedDir, 'agentd', 'run.sh');
  const requirements: WebrtcLayoutRequirement[] = [
    { label: '平台二进制', path: binaryPath, present: await isFile(binaryPath) },
    {
      label: '静态资源入口',
      path: assetsIndexPath,
      present: await isFile(assetsIndexPath) || await isDirectory(legacyAssetsPath)
    },
    { label: '设备端部署脚本', path: runScriptPath, present: await isFile(runScriptPath) }
  ];
  const missing = requirements.filter(requirement => !requirement.present);
  if (!missing.length) return;
  const error = new Error(
    `WebRTC 发布包布局不完整，缺少：${missing.map(entry => `${entry.label}（${entry.path}）`).join('、')}`
  ) as WebrtcRuntimeError;
  error.code = WEBRTC_RELEASE_LAYOUT_INVALID;
  throw error;
}

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

/**
 * 选择设备可访问的宿主机 IPv4 地址。
 *
 * 显式覆盖必须是 IPv4；自动选择时优先与设备地址同一网段的网卡，其次才使用
 * 第一个 LAN 网卡，保证容器网桥不会抢在真实网卡之前。测试可注入接口表。
 */
export function getWebrtcHostIp(
  address = '',
  interfaces: WebrtcNetworkInterfaceMap = networkInterfaces()
): string {
  const override = process.env.LA_PLUMA_WEBRTC_HOST_IP?.trim();
  if (override) {
    if (isIP(override) !== 4) throw new Error('LA_PLUMA_WEBRTC_HOST_IP 必须是宿主机的 IPv4 地址');
    return override;
  }

  const candidates = Object.entries(interfaces).flatMap(([name, entries]) => (entries || [])
    .filter(entry => !entry.internal && (entry.family === 'IPv4' || entry.family === 4))
    .map(entry => ({ ...entry, name })));
  const target = String(address).split(':')[0];
  if (isIP(target) === 4) {
    const targetNumber = ipv4Number(target);
    const match = candidates.find(entry => isIP(entry.netmask || '') === 4
      && (ipv4Number(entry.address) & ipv4Number(entry.netmask || '')) === (targetNumber & ipv4Number(entry.netmask || '')));
    if (match) return match.address;
  }

  const lanInterface = candidates.find(entry => !/^(docker|br-|veth|virbr|waydroid)/.test(entry.name));
  return lanInterface?.address || candidates[0]?.address || '127.0.0.1';
}

export interface WebrtcRuntimeMarker {
  version: string;
  installedAt: string;
}

/** 读取已安装运行时的版本标记；文件缺失、损坏或版本字段无效时返回 null。 */
export async function readWebrtcRuntimeVersion(dir: string): Promise<string | null> {
  try {
    const raw = await readFile(path.join(dir, WEBRTC_RUNTIME_MARKER_FILENAME), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const version = (parsed as { version?: unknown } | null)?.version;
    return typeof version === 'string' && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

/** 原子写入版本标记；临时文件与标记同目录，rename 保证读侧不会看到半个文件。 */
export async function writeWebrtcRuntimeMarker(dir: string, version: string): Promise<void> {
  const marker: WebrtcRuntimeMarker = { version, installedAt: new Date().toISOString() };
  const markerPath = path.join(dir, WEBRTC_RUNTIME_MARKER_FILENAME);
  const tempPath = `${markerPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  await rename(tempPath, markerPath);
}

export type WebrtcInstallAction = 'skip' | 'release' | 'upgrade' | 'build';

export interface WebrtcInstallDecision {
  binaryPresent: boolean;
  assetsPresent: boolean;
  runScriptPresent: boolean;
  buildScriptPresent: boolean;
  /** 已安装运行时的标记版本；null 表示未安装或早于版本标记的旧安装。 */
  markerVersion: string | null;
  targetVersion: string;
}

/**
 * 决定安装动作。带 build.sh 的源码 checkout 永不下载发布包：资源齐全即跳过，
 * 缺失走构建。发布包安装要求资源齐全且标记版本一致才跳过；只要存在任一旧
 * 运行时资源且未达到该条件，一律按升级覆盖处理——资源不完整不等于全新安装，
 * 否则缺项的旧安装会保留旧二进制却被写入新版本标记，升级判断从此失真。
 */
export function resolveWebrtcInstallAction(input: WebrtcInstallDecision): WebrtcInstallAction {
  if (input.buildScriptPresent) {
    return input.binaryPresent && input.assetsPresent && input.runScriptPresent ? 'skip' : 'build';
  }
  if (input.binaryPresent && input.assetsPresent && input.runScriptPresent
    && input.markerVersion === input.targetVersion) {
    return 'skip';
  }
  const anyResourcePresent = input.binaryPresent || input.assetsPresent || input.runScriptPresent;
  return anyResourcePresent ? 'upgrade' : 'release';
}

export interface WebrtcReleaseApplyOptions {
  /** 升级既有安装：整体切换运行时目录，并把既有 agentd/run.sh 备份到同目录。 */
  overwrite?: boolean;
  previousVersion?: string | null;
}

/** 升级切换使用的临时备份区；位于运行目录内，与目标同文件系统，rename 原子。 */
const UPGRADE_BACKUP_DIRNAME = '.la-pluma-upgrade-backup';

/**
 * 回填既有 run.sh 备份到新布局的同目录位置；旧安装缺少 run.sh 时不留备份。
 * 该文件是文档化的回退入口，回退旧版本时用它恢复部署脚本。
 */
async function restoreRunScriptArtifact(
  backupRoot: string,
  dir: string,
  previousVersion: string | null
): Promise<void> {
  const backupRunScript = path.join(backupRoot, 'agentd', 'run.sh');
  try {
    await access(backupRunScript);
  } catch {
    return;
  }
  const suffix = previousVersion?.replace(/[^A-Za-z0-9._-]/g, '') || 'unknown';
  await copyFile(backupRunScript, path.join(dir, 'agentd', `run.sh.before-upgrade-${suffix}`));
}

/**
 * 把解压后的发布包布局落位到运行目录：只复制 `bin`、`assets` 与 `agentd`，
 * 既有 checkout 与运行数据一律不动。
 *
 * overwrite 是升级路径，采用事务性目录切换：先清理遗留备份区，把既有运行时
 * 目录逐项改名让位到备份区，新布局就位并回填既有 run.sh 备份，最后清理备份
 * 区；任一步失败时清掉新布局残留、把让位目录改名还原，既有安装保持升级前的
 * 完整布局（回滚自身失败时保留备份区供人工恢复，并抛出原始错误）。
 */
export async function applyWebrtcReleaseLayout(
  extractedDir: string,
  dir: string,
  { overwrite = false, previousVersion = null }: WebrtcReleaseApplyOptions = {}
): Promise<void> {
  // 布局先于任何写入校验：坏包不会触碰既有运行目录，也不会停止预览资源。
  await validateWebrtcReleaseLayout(extractedDir);
  const binaryPath = getWebrtcRuntimeBinary(extractedDir);
  const binaryDir = path.dirname(path.relative(extractedDir, binaryPath));
  const layoutPaths = [binaryDir, 'assets', 'agentd'] as const;
  const backupRoot = path.join(dir, UPGRADE_BACKUP_DIRNAME);
  // 遗留备份区只可能来自升级中途被杀的进程，新布局落位前一律清掉。
  await rm(backupRoot, { recursive: true, force: true });
  if (!overwrite) {
    // Keep the existing checkout and persistent data; install only runtime resources.
    for (const relativePath of layoutPaths) {
      await cp(path.join(extractedDir, relativePath), path.join(dir, relativePath), {
        recursive: true,
        force: false,
        errorOnExist: false
      });
    }
    await chmod(getWebrtcRuntimeBinary(dir), 0o755);
    return;
  }

  const displaced: string[] = [];
  try {
    for (const relativePath of layoutPaths) {
      const targetPath = path.join(dir, relativePath);
      try {
        await access(targetPath);
      } catch {
        // 旧安装缺这一项：无需让位，由新布局直接补齐。
        continue;
      }
      const backupPath = path.join(backupRoot, relativePath);
      await mkdir(path.dirname(backupPath), { recursive: true });
      await rename(targetPath, backupPath);
      displaced.push(relativePath);
    }
    for (const relativePath of layoutPaths) {
      await cp(path.join(extractedDir, relativePath), path.join(dir, relativePath), { recursive: true });
    }
    await chmod(getWebrtcRuntimeBinary(dir), 0o755);
    await restoreRunScriptArtifact(backupRoot, dir, previousVersion);
  } catch (error) {
    // 回滚：新布局残留清掉后，让位目录改名回原位。回滚步骤自身失败时保留
    // 备份区供人工恢复，但不掩盖触发回滚的原始错误。
    try {
      for (const relativePath of layoutPaths) {
        await rm(path.join(dir, relativePath), { recursive: true, force: true });
      }
      for (const relativePath of displaced) {
        await rename(path.join(backupRoot, relativePath), path.join(dir, relativePath));
      }
      await rm(backupRoot, { recursive: true, force: true });
    } catch (rollbackError) {
      if (error instanceof Error && isErrnoException(rollbackError)) {
        error.cause = rollbackError;
      }
    }
    throw error;
  }
  await rm(backupRoot, { recursive: true, force: true });
}

export interface WebrtcInstallOptions {
  signal?: AbortSignal;
  /** 升级既有安装：事务性切换运行时目录并备份 agentd/run.sh；缺省为不覆盖的全新安装。 */
  overwrite?: boolean;
  /**
   * 发布包下载与校验全部通过后、替换既有文件前调用；升级路径用它停止受管
   * 预览资源。抛错会中止安装，既有目录保持原样，临时目录照常清理。
   */
  beforeApply?: () => Promise<void> | void;
}

/**
 * 安装上游完整发布包。
 *
 * `LA_PLUMA_WEBRTC_ARCHIVE` 可指向已下载的压缩包（离线/镜像场景）；否则从固定
 * Release URL 下载。两者都按固定 SHA-256 校验；`overwrite` 用于升级已持久化的
 * 旧版本。安装成功后写入版本标记，供后续安装识别升级。
 */
export async function installWebrtcRelease(
  dir: string,
  { signal, overwrite = false, beforeApply }: WebrtcInstallOptions = {}
): Promise<void> {
  const stagingDir = await mkdtemp(path.join(tmpdir(), 'la-pluma-webrtc-install-'));
  try {
    const archive = process.env.LA_PLUMA_WEBRTC_ARCHIVE || path.join(stagingDir, 'release.zip');
    if (!process.env.LA_PLUMA_WEBRTC_ARCHIVE) {
      const timeoutSignal = AbortSignal.timeout(180000);
      const response = await fetch(RELEASE_URL, {
        signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal
      });
      if (!response.ok || !response.body) throw new Error(`WebRTC 发布包下载失败（HTTP ${response.status}）`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { flags: 'wx' }), { signal });
    }

    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (hash.digest('hex') !== RELEASE_SHA256) throw new Error('WebRTC 发布包 SHA-256 校验失败，请重新下载官方完整发布包');

    const extractedDir = path.join(stagingDir, 'release');
    await execFileAsync('unzip', ['-q', archive, '-d', extractedDir], { timeout: 60000 });
    // 包布局先于任何写入与停止操作校验：二进制、资源入口与部署脚本必须真实
    // 存在，坏包在触碰既有运行目录之前就被拒绝。
    await validateWebrtcReleaseLayout(extractedDir);
    if (beforeApply) await beforeApply();
    await mkdir(dir, { recursive: true });
    await applyWebrtcReleaseLayout(extractedDir, dir, {
      overwrite,
      previousVersion: overwrite ? await readWebrtcRuntimeVersion(dir) : null
    });
    await writeWebrtcRuntimeMarker(dir, RELEASE_VERSION);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT' && error.syscall?.startsWith('spawn')) {
      throw new Error('安装 WebRTC 完整发布包需要 unzip，请先安装 unzip 后重试', { cause: error });
    }
    throw error;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
