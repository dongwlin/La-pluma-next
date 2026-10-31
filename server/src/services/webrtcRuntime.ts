/**
 * WebRTC 预览运行时资源：平台二进制、宿主网络地址与上游发布包安装
 *
 * - 平台：只支持上游发布包提供的 linux/darwin 的 amd64/arm64，其他组合在
 *   取得路径前抛出 `WEBRTC_UNSUPPORTED_PLATFORM`，不猜测兼容目录。
 * - 网络：`LA_PLUMA_WEBRTC_HOST_IP` 显式覆盖优先，且必须是 IPv4；否则按设备
 *   地址的 IPv4 网段匹配非内部网卡，再退回非容器网卡，最后是回环地址。
 * - 安装：下载/读取上游 zip 后按固定 SHA-256 校验，只复制 `bin`、`assets`
 *   与 `agentd` 运行时资源，保留既有 checkout 与持久数据；临时目录总是清理。
 *   下载、解压失败与包内容不完整都原样抛出，不删除已存在的运行目录。
 *
 * 进程与设备副作用不在这里：本模块只解析平台、网络与发布包，spawn、ADB 和
 * 预览子进程的所有权在 `webrtcService.ts`。
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const RELEASE_VERSION = 'v0.4.1';
const RELEASE_URL = `https://github.com/hqw700/ScrcpyOverWebRTC/releases/download/${RELEASE_VERSION}/cloudphone-${RELEASE_VERSION}.zip`;
const RELEASE_SHA256 = 'e48ca2a4c6d31d5b175c2a13f6dd423dc08bbfd380fd60b735631c589a1f8998';

/** 网卡条目只读取地址、掩码、协议族与内部标记；`os.networkInterfaces()` 与测试替身都满足。 */
export interface WebrtcNetworkInterface {
  address: string;
  netmask?: string | null;
  family: string | number;
  internal: boolean;
}

/** 以网卡名索引的接口表；缺省来自当前进程。 */
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

/**
 * 安装上游完整发布包。
 *
 * `LA_PLUMA_WEBRTC_ARCHIVE` 可指向已下载的压缩包（离线/镜像场景）；否则从固定
 * Release URL 下载。两者都按固定 SHA-256 校验，只复制运行时需要的目录。
 */
export async function installWebrtcRelease(
  dir: string,
  { signal }: { signal?: AbortSignal } = {}
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
    await mkdir(dir, { recursive: true });
    const binaryPath = getWebrtcRuntimeBinary(extractedDir);
    const binaryDir = path.dirname(path.relative(extractedDir, binaryPath));
    // Keep the existing checkout and persistent data; install only runtime resources.
    for (const relativePath of [binaryDir, 'assets', 'agentd']) {
      await cp(path.join(extractedDir, relativePath), path.join(dir, relativePath), {
        recursive: true,
        force: false,
        errorOnExist: false
      });
    }
    await chmod(getWebrtcRuntimeBinary(dir), 0o755);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT' && error.syscall?.startsWith('spawn')) {
      throw new Error('安装 WebRTC 完整发布包需要 unzip，请先安装 unzip 后重试', { cause: error });
    }
    throw error;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
