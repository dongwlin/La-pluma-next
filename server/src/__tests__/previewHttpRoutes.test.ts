import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import type { ApiSuccessResponse } from '../utils/apiHelper.ts';
import type {
  PreviewDeviceStats,
  PreviewErrorResponse,
  PreviewOrientationApplyResult,
  PreviewOrientationPlan,
  PreviewScreenshotPayload,
  PreviewWebrtcStatusPayload
} from '../controllers/previewDto.ts';

// 真实 HTTP 回归：截图、WebRTC、方向与设备采样已从 agent.ts 拆到独立
// 预览 router，这里通过 createLaPlumaApp 验证挂载、鉴权、body/query 归一化、
// dry-run 与统一错误出口保持不变。只使用临时目录、假 MAA CLI 和假 ADB，
// 不连接真实设备、不启动真实 WebRTC 服务。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-preview-routes-'));
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');
const fakeAdbPath = join(fixtureDir, 'fake-adb.js');
const adbCallLog = join(fixtureDir, 'adb-calls.log');
const fakeAdbAddress = '127.0.0.1:5555';
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

await mkdir(join(fixtureDir, 'maa-config'), { recursive: true });

await writeFile(fakeCliPath, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'dir' && args[1] === 'config') {
  process.stdout.write(process.env.FAKE_MAA_CONFIG_DIR || '');
} else if (args[0] === 'version') {
  process.stdout.write('maa-cli v0.7.0\\nMaaCore v6.2.3\\n');
} else {
  process.exit(1);
}
`, { mode: 0o755 });

await writeFile(fakeAdbPath, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_ADB_LOG, args.join(' ') + '\\n');
const address = process.env.FAKE_ADB_ADDRESS;
const png = Buffer.from(process.env.FAKE_PNG_BASE64, 'base64');
if (args[0] === 'version') {
  process.stdout.write('Android Debug Bridge version 1.0.41\\n');
} else if (args[0] === 'devices') {
  process.stdout.write('List of devices attached\\n' + address + '\\tdevice\\n');
} else if (args[0] === 'connect') {
  process.stdout.write('connected\\n');
} else if (args[0] === '-s' && args[2] === 'exec-out') {
  process.stdout.write(png);
} else if (args[0] === '-s') {
  const command = args.slice(3).join(' ');
  if (command === 'cat /proc/loadavg') process.stdout.write('0.50 0.60 0.70 1/100 1234\\n');
  else if (command === 'cat /proc/meminfo | head -4') process.stdout.write('MemTotal: 4000000 kB\\nMemFree: 1000000 kB\\nMemAvailable: 2000000 kB\\nSwapTotal: 1000000 kB\\nSwapFree: 500000 kB\\n');
  else if (command === 'df -h /data | tail -1') process.stdout.write('tmpfs 10G 5G 5G 50% /data\\n');
  else if (command === 'dumpsys battery | grep temperature') process.stdout.write('  temperature: 380\\n');
  else if (command === 'top -b -n 1 -d 0.3 | head -5') process.stdout.write('400%cpu  0%user  100%sys  0%nice 396%idle\\n');
  else if (command === 'dumpsys display') process.stdout.write('real 1920 x 1080\\nmCurrentOrientation=1\\n');
  else if (command === 'settings get system accelerometer_rotation') process.stdout.write('0\\n');
  else if (command === 'settings get system user_rotation') process.stdout.write('0\\n');
  else process.stdout.write('');
} else {
  process.exit(0);
}
`, { mode: 0o755 });

process.env.MAA_CLI_PATH = fakeCliPath;
process.env.ADB_PATH = fakeAdbPath;
process.env.FAKE_MAA_CONFIG_DIR = join(fixtureDir, 'maa-config');
process.env.FAKE_ADB_LOG = adbCallLog;
process.env.FAKE_ADB_ADDRESS = fakeAdbAddress;
process.env.FAKE_PNG_BASE64 = pngBase64;
process.env.XDG_DATA_HOME = join(fixtureDir, 'xdg-data');
process.env.XDG_STATE_HOME = join(fixtureDir, 'xdg-state');
process.env.XDG_CONFIG_HOME = join(fixtureDir, 'xdg-config');
process.env.LA_PLUMA_AGENT_RUN_STORE = join(fixtureDir, 'agent-runs.json');
process.env.LA_PLUMA_MAA_LOCK_FILE = join(fixtureDir, 'maa-execution.lock');
process.env.LA_PLUMA_WEBRTC_DIR = join(fixtureDir, 'webrtc');
process.env.LA_PLUMA_WEBRTC_PORT = '45871';
process.env.LA_PLUMA_WEBRTC_ICE_SERVERS = '';

const { createLaPlumaApp } = await import('../app.ts');
const { loggerManager } = await import('../utils/logger.ts');

// 真实 HTTP 用例会触发服务日志；控制台输出关闭，避免门禁输出被诊断行淹没。
for (const loggerName of ['Api', 'MaaService', 'AgentRoutes']) {
  loggerManager.getLogger(loggerName).enableConsole = false;
}

const servers: Server[] = [];
const originalConsoleError = console.error;

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

function agentUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port}/api/agent${path}`;
}

function jsonRequest(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
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

afterEach(async () => {
  console.error = originalConsoleError;
  while (servers.length) {
    const server = servers.pop();
    assert.ok(server);
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

after(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('preview routes over real HTTP', () => {
  it('requires the API token on every preview entry', async () => {
    const app = createLaPlumaApp({
      env: { LA_PLUMA_TOKEN: 'api-secret' },
      loginRateLimit: { maxAuthFailures: 100 }
    });
    const port = await listen(app);

    const entries: Array<[string, string]> = [
      ['POST', '/screen/screenshot'],
      ['GET', '/webrtc/status'],
      ['GET', '/webrtc/devices'],
      ['POST', '/webrtc/start'],
      ['POST', '/webrtc/stop'],
      ['POST', '/preview/orientation'],
      ['POST', '/webrtc/install'],
      ['POST', '/webrtc/start-server'],
      ['POST', '/webrtc/stop-server'],
      ['POST', '/webrtc/start-agent'],
      ['POST', '/webrtc/stop-agent'],
      ['GET', '/device-stats']
    ];

    for (const [method, path] of entries) {
      const response = await fetch(agentUrl(port, path), { method });
      assert.equal(response.status, 401, `${method} ${path} must stay behind auth`);
      const body = await readBody<PreviewErrorResponse>(response);
      assert.equal(body.error.code, 'AGENT_AUTH_REQUIRED');
    }
  });

  it('keeps screenshot, orientation and device sampling responses intact', async () => {
    const app = createLaPlumaApp({ env: {} });
    const port = await listen(app);
    const connection = { adbPath: fakeAdbPath, address: fakeAdbAddress };

    const screenshot = await fetch(agentUrl(port, '/screen/screenshot'), jsonRequest(connection));
    assert.equal(screenshot.status, 200);
    const screenshotBody = await readBody<ApiSuccessResponse<PreviewScreenshotPayload>>(screenshot);
    assert.equal(screenshotBody.data.mediaType, 'image/png');
    assert.equal(screenshotBody.data.width, 1);
    assert.equal(screenshotBody.data.height, 1);
    assert.equal(screenshotBody.data.image, pngBase64);
    assert.equal(screenshotBody.data.adbPath, fakeAdbPath);
    assert.equal(screenshotBody.data.address, fakeAdbAddress);
    assert.equal(screenshotBody.data.profileId, 'default');

    const dryRun = await fetch(agentUrl(port, '/preview/orientation'), jsonRequest({
      ...connection,
      orientation: 'landscape',
      dryRun: true
    }));
    assert.equal(dryRun.status, 200);
    const dryRunBody = await readBody<ApiSuccessResponse<{ plan: PreviewOrientationPlan }>>(dryRun);
    assert.equal(dryRunBody.meta.dryRun, true);
    assert.equal(dryRunBody.data.plan.action, 'preview-orientation');
    assert.equal(dryRunBody.data.plan.orientation, 'landscape');
    assert.equal(dryRunBody.data.plan.commands.length, 3);
    assert.deepEqual(dryRunBody.data.plan.commands[0].args, [
      '-s', fakeAdbAddress, 'shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'
    ]);

    const invalid = await fetch(agentUrl(port, '/preview/orientation'), jsonRequest({
      ...connection,
      orientation: 'sideways'
    }));
    assert.equal(invalid.status, 400);
    const invalidBody = await readBody<PreviewErrorResponse>(invalid);
    assert.equal(invalidBody.error.code, 'AGENT_VALIDATION_ORIENTATION_INVALID');

    const applied = await fetch(agentUrl(port, '/preview/orientation'), jsonRequest({
      ...connection,
      orientation: 'landscape'
    }));
    assert.equal(applied.status, 200);
    const appliedBody = await readBody<ApiSuccessResponse<PreviewOrientationApplyResult>>(applied);
    assert.equal(appliedBody.data.action, 'preview-orientation');
    assert.equal(appliedBody.data.results.length, 3);
    assert.ok(appliedBody.data.results.every(result => result.ok));
    assert.equal(appliedBody.data.observed.width, 1920);
    assert.equal(appliedBody.data.observed.height, 1080);
    assert.equal(appliedBody.data.observed.rotation, 1);
    assert.equal(appliedBody.data.observed.inferredOrientation, 'landscape');

    const stats = await fetch(agentUrl(port, `/device-stats?${new URLSearchParams(connection)}`));
    assert.equal(stats.status, 200);
    const statsBody = await readBody<ApiSuccessResponse<PreviewDeviceStats | null>>(stats);
    assert.ok(statsBody.data);
    assert.equal(statsBody.data.cpuPct, 1);
    assert.equal(statsBody.data.memTotalKb, 4000000);
    assert.equal(statsBody.data.memUsedKb, 2000000);
    assert.equal(statsBody.data.memPct, 50);
    assert.equal(statsBody.data.diskTotal, '10G');
    assert.equal(statsBody.data.diskPct, 50);
    assert.equal(statsBody.data.temp, 38);
  });

  it('keeps WebRTC status and device listing same-origin without exposing upstream management', async () => {
    const app = createLaPlumaApp({ env: {} });
    const port = await listen(app);
    const query = new URLSearchParams({ adbPath: fakeAdbPath, address: fakeAdbAddress });

    const status = await fetch(agentUrl(port, `/webrtc/status?${query}`));
    assert.equal(status.status, 200);
    const statusBody = await readBody<ApiSuccessResponse<PreviewWebrtcStatusPayload>>(status);
    assert.equal(statusBody.data.signalingUrl, '/webrtc-signaling');
    assert.equal(statusBody.data.profileId, 'default');
    assert.ok(Array.isArray(statusBody.data.devices));
    const ownership = statusBody.data.ownership;
    assert.ok(ownership);
    assert.deepEqual(Object.keys(ownership).sort(), ['agent', 'server', 'turn']);
    for (const owner of Object.values(ownership)) {
      assert.ok(['managed', 'external', 'none'].includes(owner));
    }

    const devices = await fetch(agentUrl(port, '/webrtc/devices'));
    assert.equal(devices.status, 200);
    const devicesBody = await readBody<ApiSuccessResponse<{ devices: string[] }>>(devices);
    assert.ok(Array.isArray(devicesBody.data.devices));
  });

  it('routes preview failures through the unified error exit', async () => {
    const app = createLaPlumaApp({ env: {} });
    const port = await listen(app);
    console.error = () => {};

    const response = await fetch(agentUrl(port, '/screen/screenshot'), jsonRequest({
      adbPath: join(fixtureDir, 'missing-adb'),
      address: fakeAdbAddress
    }));

    assert.equal(response.status, 500);
    const body = await readBody<PreviewErrorResponse>(response);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'AGENT_INTERNAL_ERROR');
    assert.equal(body.message, '服务器内部错误');
    assert.ok(!JSON.stringify(body).includes('截图失败'));
  });
});
