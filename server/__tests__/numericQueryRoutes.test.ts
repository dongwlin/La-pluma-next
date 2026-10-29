import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import type { ApiSuccessResponse } from '../utils/apiHelper.ts';
import type { DropRecordDay, DropStatistics } from '../services/dropRecordService.ts';
import type { MaaLogFileContent } from '../services/maaLogFileService.ts';
import type { MaaRealtimeLogEntry } from '../services/maaProcessService.ts';
import type { WebrtcSignalingGateway } from '../services/webrtcSignalingGateway.ts';
import { loggerManager } from '../utils/logger.ts';

// 相关环境变量均在模块导入前设置：MAA_CLI_PATH 与 LA_PLUMA_DROP_RECORDS_DIR
// 由被测模块在导入时读取，测试因此使用假 CLI 与临时目录，不触碰真实运行数据。
// 注意：webrtcSignalingGateway 及其传递依赖会在导入时读取 MAA_CLI_PATH，
// 必须等环境变量就绪后再动态导入，不能用顶层静态导入。
//
// 本文件锁定数值 query 的既有边界：重复参数是数组、NaN/Infinity 等非有限值
// 回落默认值，有限值截断并夹取；响应按各端点声明的 DTO 读取。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-numeric-query-'));
const dropDir = join(fixtureDir, 'drop-records');
const maaLogDir = join(fixtureDir, 'maa-logs');
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');

await mkdir(dropDir, { recursive: true });
await mkdir(maaLogDir, { recursive: true });
await writeFile(fakeCliPath, `#!${process.execPath}
if (process.argv[2] === 'dir' && process.argv[3] === 'log') {
  // 不显式 exit：stdout 为管道时立即 exit 可能截断输出
  process.stdout.write(process.env.FAKE_MAA_LOG_DIR || '');
} else {
  process.exit(1);
}
`, { mode: 0o755 });

const LOG_FILE_TOTAL_LINES = 6000;
const logFilePath = join(maaLogDir, 'asst.log');
{
  const lines: string[] = [];
  for (let i = 1; i <= LOG_FILE_TOTAL_LINES; i++) lines.push(`log line ${i}`);
  await writeFile(logFilePath, lines.join('\n'), 'utf-8');
}

process.env.MAA_CLI_PATH = fakeCliPath;
process.env.FAKE_MAA_LOG_DIR = maaLogDir;
process.env.LA_PLUMA_DROP_RECORDS_DIR = dropDir;

const { WEBRTC_SIGNALING_PATH } = await import('../services/webrtcSignalingGateway.ts');
const { createLaPlumaApp } = await import('../app.ts');
const { getLocalDateString } = await import('../services/dropRecordService.ts');
const { setTaskStatus, clearRealtimeLogs } = await import('../services/maaProcessService.ts');

loggerManager.getLogger('MaaService').enableConsole = false;

const servers: Server[] = [];

async function listen(app: ReturnType<typeof createLaPlumaApp>): Promise<number> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

function createRecord(date: string): DropRecordDay {
  return {
    date,
    records: [],
    summary: { totalSanity: 0, totalMedicine: 0, totalStone: 0, totalBattles: 0, itemsSummary: {} }
  };
}

async function seedRecentDropDays(dayOffsets: number[]): Promise<void> {
  for (const offset of dayOffsets) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    const dateStr = getLocalDateString(date);
    await writeFile(join(dropDir, `${dateStr}.json`), JSON.stringify(createRecord(dateStr)), 'utf-8');
  }
}

async function clearDropDir(): Promise<void> {
  const entries = await readdir(dropDir).catch((): string[] => []);
  for (const entry of entries) {
    await rm(join(dropDir, entry), { recursive: true, force: true });
  }
}

function seedRealtimeLogs(count = 510): void {
  clearRealtimeLogs();
  for (let i = 0; i < count; i++) {
    setTaskStatus(i % 2 === 0, `seed-task-${i}`, 'automation');
  }
  setTaskStatus(false);
}

interface ApiEnvelopeLike {
  success: boolean;
}

function isApiEnvelope(value: unknown): value is ApiEnvelopeLike {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as { success?: unknown }).success === 'boolean';
}

/** fetch 的 JSON 载荷是 unknown；先确认统一信封，再按端点声明的 DTO 读取。 */
async function readBody<T>(response: Response): Promise<T> {
  const body: unknown = await response.json();
  assert.ok(isApiEnvelope(body));
  return body as T;
}

function fetchDrops(baseUrl: string, path: string): Promise<Response> {
  return fetch(`${baseUrl}/api/agent/drops/${path}`);
}

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    assert.ok(server);
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  setTaskStatus(false);
  clearRealtimeLogs();
  await clearDropDir();
});

after(async () => {
  setTaskStatus(false);
  clearRealtimeLogs();
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('GET /api/agent/drops/recent numeric query bounds', () => {
  it('uses the 7-day default for omitted, invalid and repeated days', async () => {
    await seedRecentDropDays([0, 1, 3]);
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    for (const query of ['', '?days=abc', '?days=NaN', '?days=1&days=2']) {
      const response = await fetchDrops(`http://127.0.0.1:${port}`, `recent${query}`);
      assert.equal(response.status, 200);
      const body = await readBody<ApiSuccessResponse<DropRecordDay[]>>(response);
      assert.equal(body.success, true);
      assert.equal(body.data.length, 3);
    }
  });

  it('limits the window to the requested integer days', async () => {
    await seedRecentDropDays([0, 1, 3]);
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const baseUrl = `http://127.0.0.1:${port}`;
    const twoDays = await readBody<ApiSuccessResponse<DropRecordDay[]>>(await fetchDrops(baseUrl, 'recent?days=2'));
    assert.equal(twoDays.data.length, 2);
    const truncated = await readBody<ApiSuccessResponse<DropRecordDay[]>>(await fetchDrops(baseUrl, 'recent?days=2.9'));
    assert.equal(truncated.data.length, 2);
    const clampedUp = await readBody<ApiSuccessResponse<DropRecordDay[]>>(await fetchDrops(baseUrl, 'recent?days=-5'));
    assert.equal(clampedUp.data.length, 1);
  });

  it('bounds Infinity and oversized days instead of an unbounded history read', { timeout: 15000 }, async () => {
    await seedRecentDropDays([0, 1, 3]);
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    for (const query of ['?days=Infinity', '?days=1e9', '?days=100000']) {
      const response = await fetchDrops(`http://127.0.0.1:${port}`, `recent${query}`);
      assert.equal(response.status, 200);
      const body = await readBody<ApiSuccessResponse<DropRecordDay[]>>(response);
      assert.equal(body.data.length, 3);
    }
  });
});

describe('GET /api/agent/drops/statistics numeric query bounds', () => {
  it('bounds the aggregated window for invalid and oversized days', { timeout: 15000 }, async () => {
    await seedRecentDropDays([0, 1, 3]);
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    for (const query of ['?days=abc', '?days=NaN', '?days=Infinity', '?days=1e9']) {
      const response = await fetchDrops(`http://127.0.0.1:${port}`, `statistics${query}`);
      assert.equal(response.status, 200);
      const body = await readBody<ApiSuccessResponse<DropStatistics>>(response);
      assert.equal(body.success, true);
      assert.equal(body.data.dateRange.days, 3);
      assert.equal(body.data.dailyTrend.length, 3);
    }
  });
});

describe('GET /api/agent/logs/recent numeric query bounds', () => {
  it('uses the 80-line default for omitted, invalid and repeated lines', async () => {
    seedRealtimeLogs();
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    for (const query of ['', '?lines=abc', '?lines=NaN', '?lines=1&lines=2']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/logs/recent${query}`);
      assert.equal(response.status, 200);
      const body = await readBody<ApiSuccessResponse<MaaRealtimeLogEntry[]>>(response);
      assert.equal(body.data.length, 80);
    }
  });

  it('falls back to the default for Infinity and clamps oversized finite lines to the 500-line cap', async () => {
    seedRealtimeLogs();
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    for (const query of ['?lines=Infinity', '?lines=1e999']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/logs/recent${query}`);
      const body = await readBody<ApiSuccessResponse<MaaRealtimeLogEntry[]>>(response);
      assert.equal(body.data.length, 80);
    }
    for (const query of ['?lines=1e9', '?lines=1000']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/logs/recent${query}`);
      const body = await readBody<ApiSuccessResponse<MaaRealtimeLogEntry[]>>(response);
      assert.equal(body.data.length, 500);
    }
  });
});

describe('GET /api/agent/logs/files numeric query bounds', () => {
  const encodedPath = encodeURIComponent(logFilePath);

  it('uses the 1000-line default for omitted, invalid and repeated lines', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    for (const query of ['', '?lines=abc', '?lines=NaN', '?lines=1&lines=2']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/logs/files/${encodedPath}${query}`);
      assert.equal(response.status, 200);
      const body = await readBody<ApiSuccessResponse<MaaLogFileContent>>(response);
      assert.equal(body.data.totalLines, LOG_FILE_TOTAL_LINES);
      assert.equal(body.data.returnedLines, 1000);
      assert.ok(body.data.content.endsWith(`log line ${LOG_FILE_TOTAL_LINES}`));
    }
  });

  it('falls back to the default for Infinity and clamps oversized finite lines to the 5000-line cap', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const infinity = await readBody<ApiSuccessResponse<MaaLogFileContent>>(
      await fetch(`http://127.0.0.1:${port}/api/agent/logs/files/${encodedPath}?lines=Infinity`)
    );
    assert.equal(infinity.data.returnedLines, 1000);
    for (const query of ['?lines=1e21', '?lines=6000']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/logs/files/${encodedPath}${query}`);
      const body = await readBody<ApiSuccessResponse<MaaLogFileContent>>(response);
      assert.equal(body.data.returnedLines, 5000);
      assert.ok(body.data.content.endsWith(`log line ${LOG_FILE_TOTAL_LINES}`));
    }
  });
});

/** 信令网关桩：应用只读取 proxyPath 与登录入口，本文件不建立 WebRTC 连接。 */
function stubSignalingGateway(): WebrtcSignalingGateway {
  return {
    proxyPath: WEBRTC_SIGNALING_PATH,
    async handleLogin(_req, res) {
      res.json({ token: 'stub' });
    },
    async handleUpgrade() {},
    attach() {},
    close() {}
  };
}
