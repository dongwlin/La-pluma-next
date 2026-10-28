import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { loggerManager } from '../utils/logger.ts';

// 相关环境变量均在模块导入前设置：MAA_CLI_PATH 与 LA_PLUMA_DROP_RECORDS_DIR
// 由被测模块在导入时读取，测试因此使用假 CLI 与临时目录，不触碰真实运行数据。
// 注意：webrtcSignalingGateway 及其传递依赖会在导入时读取 MAA_CLI_PATH，
// 必须等环境变量就绪后再动态导入，不能用顶层静态导入。
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
  const lines = [];
  for (let i = 1; i <= LOG_FILE_TOTAL_LINES; i++) lines.push(`log line ${i}`);
  await writeFile(logFilePath, lines.join('\n'), 'utf-8');
}

process.env.MAA_CLI_PATH = fakeCliPath;
process.env.FAKE_MAA_LOG_DIR = maaLogDir;
process.env.LA_PLUMA_DROP_RECORDS_DIR = dropDir;

const { WEBRTC_SIGNALING_PATH } = await import('../services/webrtcSignalingGateway.js');
const { createLaPlumaApp } = await import('../server.js');
const { getLocalDateString } = await import('../services/dropRecordService.ts');
const { setTaskStatus, clearRealtimeLogs } = await import('../services/maaProcessService.ts');

loggerManager.getLogger('MaaService').enableConsole = false;

const servers = [];

async function listen(app) {
  const server = createServer(app);
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function createRecord(date) {
  return {
    date,
    records: [],
    summary: { totalSanity: 0, totalMedicine: 0, totalStone: 0, totalBattles: 0, itemsSummary: {} }
  };
}

async function seedRecentDropDays(dayOffsets) {
  for (const offset of dayOffsets) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    const dateStr = getLocalDateString(date);
    await writeFile(join(dropDir, `${dateStr}.json`), JSON.stringify(createRecord(dateStr)), 'utf-8');
  }
}

async function clearDropDir() {
  const entries = await readdir(dropDir).catch(() => []);
  for (const entry of entries) {
    await rm(join(dropDir, entry), { recursive: true, force: true });
  }
}

function seedRealtimeLogs(count = 510) {
  clearRealtimeLogs();
  for (let i = 0; i < count; i++) {
    setTaskStatus(i % 2 === 0, `seed-task-${i}`, 'automation');
  }
  setTaskStatus(false);
}

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
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
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/drops/recent${query}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.success, true);
      assert.equal(body.data.length, 3);
    }
  });

  it('limits the window to the requested integer days', async () => {
    await seedRecentDropDays([0, 1, 3]);
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const twoDays = await (await fetch(`http://127.0.0.1:${port}/api/agent/drops/recent?days=2`)).json();
    assert.equal(twoDays.data.length, 2);
    const truncated = await (await fetch(`http://127.0.0.1:${port}/api/agent/drops/recent?days=2.9`)).json();
    assert.equal(truncated.data.length, 2);
    const clampedUp = await (await fetch(`http://127.0.0.1:${port}/api/agent/drops/recent?days=-5`)).json();
    assert.equal(clampedUp.data.length, 1);
  });

  it('bounds Infinity and oversized days instead of an unbounded history read', { timeout: 15000 }, async () => {
    await seedRecentDropDays([0, 1, 3]);
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    for (const query of ['?days=Infinity', '?days=1e9', '?days=100000']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/drops/recent${query}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.data.length, 3);
    }
  });

  it('keeps valid in-range requests untouched', async () => {
    await seedRecentDropDays([0, 1, 3, 10, 20]);
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const response = await fetch(`http://127.0.0.1:${port}/api/agent/drops/recent?days=30`);
    const body = await response.json();
    assert.equal(body.data.length, 5);
  });
});

describe('GET /api/agent/drops/statistics numeric query bounds', () => {
  it('bounds the aggregated window for invalid and oversized days', { timeout: 15000 }, async () => {
    await seedRecentDropDays([0, 1, 3]);
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    for (const query of ['?days=abc', '?days=NaN', '?days=Infinity', '?days=1e9']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/drops/statistics${query}`);
      assert.equal(response.status, 200);
      const body = await response.json();
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
      const body = await response.json();
      assert.equal(body.data.length, 80);
    }
  });

  it('falls back to the default for Infinity and clamps oversized finite lines to the 500-line cap', async () => {
    seedRealtimeLogs();
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    for (const query of ['?lines=Infinity', '?lines=1e999']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/logs/recent${query}`);
      const body = await response.json();
      assert.equal(body.data.length, 80);
    }
    for (const query of ['?lines=1e9', '?lines=1000']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/logs/recent${query}`);
      const body = await response.json();
      assert.equal(body.data.length, 500);
    }
  });

  it('clamps negatives and zero to one line and truncates decimals', async () => {
    seedRealtimeLogs();
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/agent/logs/recent?lines=-5`)).json()).data.length, 1);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/agent/logs/recent?lines=0`)).json()).data.length, 1);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/agent/logs/recent?lines=3.9`)).json()).data.length, 3);
  });

  it('keeps valid in-range requests untouched', async () => {
    seedRealtimeLogs();
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/agent/logs/recent?lines=200`)).json()).data.length, 200);
  });
});

describe('GET /api/agent/logs/files numeric query bounds', () => {
  const encodedPath = encodeURIComponent(logFilePath);

  it('uses the 1000-line default for omitted, invalid and repeated lines', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    for (const query of ['', '?lines=abc', '?lines=NaN', '?lines=1&lines=2']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/logs/files/${encodedPath}${query}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.data.totalLines, LOG_FILE_TOTAL_LINES);
      assert.equal(body.data.returnedLines, 1000);
      assert.ok(body.data.content.endsWith(`log line ${LOG_FILE_TOTAL_LINES}`));
    }
  });

  it('falls back to the default for Infinity and clamps oversized finite lines to the 5000-line cap', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const infinity = await (await fetch(`http://127.0.0.1:${port}/api/agent/logs/files/${encodedPath}?lines=Infinity`)).json();
    assert.equal(infinity.data.returnedLines, 1000);
    for (const query of ['?lines=1e21', '?lines=6000']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/agent/logs/files/${encodedPath}${query}`);
      const body = await response.json();
      assert.equal(body.data.returnedLines, 5000);
      assert.ok(body.data.content.endsWith(`log line ${LOG_FILE_TOTAL_LINES}`));
    }
  });

  it('clamps negatives and zero to one line and truncates decimals', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const negative = await (await fetch(`http://127.0.0.1:${port}/api/agent/logs/files/${encodedPath}?lines=-5`)).json();
    assert.equal(negative.data.returnedLines, 1);
    const decimal = await (await fetch(`http://127.0.0.1:${port}/api/agent/logs/files/${encodedPath}?lines=3.9`)).json();
    assert.equal(decimal.data.returnedLines, 3);
    assert.ok(decimal.data.content.endsWith(`log line ${LOG_FILE_TOTAL_LINES}`));
  });

  it('keeps valid in-range requests untouched', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const response = await fetch(`http://127.0.0.1:${port}/api/agent/logs/files/${encodedPath}?lines=200`);
    const body = await response.json();
    assert.equal(body.data.returnedLines, 200);
    assert.ok(body.data.content.endsWith(`log line ${LOG_FILE_TOTAL_LINES}`));
  });
});

function stubSignalingGateway() {
  return {
    proxyPath: WEBRTC_SIGNALING_PATH,
    handleLogin(_req, res) {
      res.json({ token: 'stub' });
    }
  };
}
