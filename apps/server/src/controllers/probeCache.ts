/**
 * 进程内探测缓存：同一键在 TTL 内复用结果，并发读取共享同一次在途探测。
 * `/status` 与 `/diagnostics` 的 MAA 版本、ADB 摘要在这里共用，避免轮询与
 * 诊断请求成倍启动子进程；缓存只在进程内，重启即清空，不写盘、不跨实例。
 */
import { getMaaVersion } from '../services/maaExecutionService.ts';
import type { MaaVersionInfo } from '../services/maaExecutionService.ts';
import { getAdbSummary, getAndroidDisplayState, getWebrtcSummary } from './deviceStatus.ts';
import type { AdbSummary, AndroidDisplayState, WebrtcSummary } from './deviceStatus.ts';
import { readErrorMessage } from './readDto.ts';
import type { AdbStatusFailure, MaaVersionFailure, OrientationStatusFailure } from './statusDto.ts';

/** 四项外部探测的短 TTL：轮询突发共享结果，设备变化最迟约 1.5 秒后重新探测。 */
export const STATUS_PROBE_CACHE_TTL = 1500;

/** 缓存条目上限：连接参数可来自请求覆盖，不能让缓存键随任意地址无限增长。 */
const MAX_PROBE_CACHE_ENTRIES = 64;

export interface ProbeCache<T> {
  /** TTL 内返回缓存值；同键在途读取直接共享，不重复执行 load。 */
  read(key: string, load: () => Promise<T>): Promise<T>;
  reset(): void;
}

interface ProbeCacheOptions {
  ttlMs: number;
  maxEntries?: number;
  now?: () => number;
}

export function createProbeCache<T>({
  ttlMs,
  maxEntries = MAX_PROBE_CACHE_ENTRIES,
  now = Date.now
}: ProbeCacheOptions): ProbeCache<T> {
  const entries = new Map<string, { timestamp: number; value: T }>();
  const pending = new Map<string, Promise<T>>();

  return {
    read(key, load) {
      const cached = entries.get(key);
      if (cached && now() - cached.timestamp < ttlMs) return Promise.resolve(cached.value);

      const inFlight = pending.get(key);
      if (inFlight) return inFlight;

      let request: Promise<T>;
      request = load()
        .then(value => {
          entries.set(key, { timestamp: now(), value });
          if (entries.size > maxEntries) {
            const oldestKey = entries.keys().next().value;
            if (oldestKey !== undefined) entries.delete(oldestKey);
          }
          return value;
        })
        .finally(() => {
          if (pending.get(key) === request) pending.delete(key);
        });
      pending.set(key, request);
      return request;
    },
    reset() {
      entries.clear();
      pending.clear();
    }
  };
}

/** 响应会携带 adbPath；同一 address 下不同 ADB 路径不能共用探测结果。 */
function statusProbeKey(adbPath: string, address: string): string {
  return `${address}\u0000${adbPath}`;
}

const versionProbes = createProbeCache<MaaVersionInfo | MaaVersionFailure>({ ttlMs: STATUS_PROBE_CACHE_TTL });
const adbProbes = createProbeCache<AdbSummary | AdbStatusFailure>({ ttlMs: STATUS_PROBE_CACHE_TTL });
const webrtcProbes = createProbeCache<WebrtcSummary>({ ttlMs: STATUS_PROBE_CACHE_TTL });
const orientationProbes = createProbeCache<AndroidDisplayState | OrientationStatusFailure>({
  ttlMs: STATUS_PROBE_CACHE_TTL
});

/** MAA 版本与具体设备无关，同一进程内的所有连接共享同一次探测。 */
export function readMaaVersionProbe(): Promise<MaaVersionInfo | MaaVersionFailure> {
  return versionProbes.read('', () => getMaaVersion(true).catch(
    (error): MaaVersionFailure => ({ error: readErrorMessage(error) })
  ));
}

export function readAdbProbe(adbPath: string, address: string): Promise<AdbSummary | AdbStatusFailure> {
  return adbProbes.read(statusProbeKey(adbPath, address), () => getAdbSummary(adbPath, address).catch(
    (error): AdbStatusFailure => ({ connected: false, error: readErrorMessage(error), adbPath, address })
  ));
}

export function readWebrtcProbe(address: string, adbPath: string): Promise<WebrtcSummary> {
  return webrtcProbes.read(statusProbeKey(adbPath, address), () => getWebrtcSummary(address, adbPath));
}

export function readOrientationProbe(
  adbPath: string,
  address: string
): Promise<AndroidDisplayState | OrientationStatusFailure> {
  return orientationProbes.read(statusProbeKey(adbPath, address), () => getAndroidDisplayState(adbPath, address).catch(
    (error): OrientationStatusFailure => ({ error: readErrorMessage(error), adbPath, address })
  ));
}

export function resetStatusProbeCacheForTests(): void {
  versionProbes.reset();
  adbProbes.reset();
  webrtcProbes.reset();
  orientationProbes.reset();
}
