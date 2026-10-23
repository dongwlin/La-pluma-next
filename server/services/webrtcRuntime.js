import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { isIP } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const RELEASE_VERSION = 'v0.4.1'
const RELEASE_URL = `https://github.com/hqw700/ScrcpyOverWebRTC/releases/download/${RELEASE_VERSION}/cloudphone-${RELEASE_VERSION}.zip`
const RELEASE_SHA256 = 'e48ca2a4c6d31d5b175c2a13f6dd423dc08bbfd380fd60b735631c589a1f8998'

export function getWebrtcRuntimeBinary(dir, platform = process.platform, arch = process.arch) {
  const releaseArch = { x64: 'amd64', arm64: 'arm64' }[arch]
  if (!['linux', 'darwin'].includes(platform) || !releaseArch) {
    const error = new Error(`WebRTC 预览暂不支持此系统架构：${platform}/${arch}`)
    error.code = 'WEBRTC_UNSUPPORTED_PLATFORM'
    throw error
  }
  return path.join(dir, 'bin', `${platform}_${releaseArch}`, 'webrtc-signaling')
}

function ipv4Number(address) {
  return address.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0)
}

export function getWebrtcHostIp(address = '', interfaces = networkInterfaces()) {
  const override = process.env.LA_PLUMA_WEBRTC_HOST_IP?.trim()
  if (override) {
    if (isIP(override) !== 4) throw new Error('LA_PLUMA_WEBRTC_HOST_IP 必须是宿主机的 IPv4 地址')
    return override
  }

  const candidates = Object.entries(interfaces).flatMap(([name, entries]) => (entries || [])
    .filter(entry => !entry.internal && (entry.family === 'IPv4' || entry.family === 4))
    .map(entry => ({ ...entry, name })))
  const target = String(address).split(':')[0]
  if (isIP(target) === 4) {
    const targetNumber = ipv4Number(target)
    const match = candidates.find(entry => isIP(entry.netmask || '') === 4
      && (ipv4Number(entry.address) & ipv4Number(entry.netmask)) === (targetNumber & ipv4Number(entry.netmask)))
    if (match) return match.address
  }

  const lanInterface = candidates.find(entry => !/^(docker|br-|veth|virbr|waydroid)/.test(entry.name))
  return lanInterface?.address || candidates[0]?.address || '127.0.0.1'
}

export async function installWebrtcRelease(dir) {
  const stagingDir = await mkdtemp(path.join(tmpdir(), 'la-pluma-webrtc-install-'))
  try {
    const archive = process.env.LA_PLUMA_WEBRTC_ARCHIVE || path.join(stagingDir, 'release.zip')
    if (!process.env.LA_PLUMA_WEBRTC_ARCHIVE) {
      const response = await fetch(RELEASE_URL, { signal: AbortSignal.timeout(180000) })
      if (!response.ok || !response.body) throw new Error(`WebRTC 发布包下载失败（HTTP ${response.status}）`)
      await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { flags: 'wx' }))
    }

    const hash = createHash('sha256')
    for await (const chunk of createReadStream(archive)) hash.update(chunk)
    if (hash.digest('hex') !== RELEASE_SHA256) throw new Error('WebRTC 发布包 SHA-256 校验失败，请重新下载官方完整发布包')

    const extractedDir = path.join(stagingDir, 'release')
    await execFileAsync('unzip', ['-q', archive, '-d', extractedDir], { timeout: 60000 })
    await mkdir(dir, { recursive: true })
    const binaryPath = getWebrtcRuntimeBinary(extractedDir)
    const binaryDir = path.dirname(path.relative(extractedDir, binaryPath))
    // Keep the existing checkout and persistent data; install only runtime resources.
    for (const relativePath of [binaryDir, 'assets', 'agentd']) {
      await cp(path.join(extractedDir, relativePath), path.join(dir, relativePath), {
        recursive: true,
        force: false,
        errorOnExist: false
      })
    }
    await chmod(getWebrtcRuntimeBinary(dir), 0o755)
  } catch (error) {
    if (error.code === 'ENOENT' && error.syscall?.startsWith('spawn')) {
      throw new Error('安装 WebRTC 完整发布包需要 unzip，请先安装 unzip 后重试', { cause: error })
    }
    throw error
  } finally {
    await rm(stagingDir, { recursive: true, force: true })
  }
}
