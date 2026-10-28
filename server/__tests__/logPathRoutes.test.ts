import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import type { ApiErrorResponse, ApiSuccessResponse } from '../utils/apiHelper.ts';
import type { MaaLogFileContent, MaaLogFileEntry } from '../services/maaLogFileService.ts';
import type { WebrtcSignalingGateway } from '../services/webrtcSignalingGateway.ts';
import { loggerManager } from '../utils/logger.ts';

// 相关环境变量均在模块导入前设置：MAA_CLI_PATH 由被测模块在导入时读取，
// 测试因此使用假 CLI 与临时日志目录，不读取真实设备日志。
// 注意：webrtcSignalingGateway 及其传递依赖会在导入时读取 MAA_CLI_PATH，
// 必须等环境变量就绪后再动态导入，不能用顶层静态导入。
// 响应按日志边界的领域类型读取；越界与解码失败按统一错误信封收窄。
const fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-log-path-'));
const maaLogDir = join(fixtureDir, 'maa-logs');
const outsideDir = join(fixtureDir, 'outside');
const fakeCliPath = join(fixtureDir, 'fake-maa-cli.js');

await mkdir(join(maaLogDir, 'sub'), { recursive: true });
await mkdir(outsideDir, { recursive: true });
await writeFile(fakeCliPath, `#!${process.execPath}
if (process.argv[2] === 'dir' && process.argv[3] === 'log') {
  // 不显式 exit：stdout 为管道时立即 exit 可能截断输出
  process.stdout.write(process.env.FAKE_MAA_LOG_DIR || '');
} else {
  process.exit(1);
}
`, { mode: 0o755 });

// 文件名固定覆盖：嵌套目录、结尾为 % 的名字、字面 %20 的名字与含空格的名字。
// 客户端把文件列表返回的绝对路径做一次 encodeURIComponent 后请求，
// 服务端必须只解码一次。
const NESTED_LOG = join(maaLogDir, 'sub', 'run-1.log');
const TRAILING_PERCENT_LOG = join(maaLogDir, '100%.log');
const LITERAL_PERCENT_LOG = join(maaLogDir, 'a%20b.log');
const SPACE_LOG = join(maaLogDir, 'space name.log');
const OUTSIDE_LOG = join(outsideDir, 'secret.log');

await writeFile(NESTED_LOG, 'nested run log', 'utf-8');
await writeFile(TRAILING_PERCENT_LOG, 'trailing percent log', 'utf-8');
await writeFile(LITERAL_PERCENT_LOG, 'literal percent-twenty log', 'utf-8');
await writeFile(SPACE_LOG, 'space log', 'utf-8');
await writeFile(join(maaLogDir, 'notes.txt'), 'not a log', 'utf-8');
await writeFile(OUTSIDE_LOG, 'outside secret', 'utf-8');
// 目录内符号链接指向目录外：由 realpath 越界判定拒绝，不做额外解码
await symlink(OUTSIDE_LOG, join(maaLogDir, 'escape.log'));
await symlink(outsideDir, join(maaLogDir, 'sub-alias'));

process.env.MAA_CLI_PATH = fakeCliPath;
process.env.FAKE_MAA_LOG_DIR = maaLogDir;

const { WEBRTC_SIGNALING_PATH } = await import('../services/webrtcSignalingGateway.ts');
const { createLaPlumaApp } = await import('../server.ts');

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

async function listenAndFetch(pathSuffix: string): Promise<Response> {
  const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
  return fetch(`http://127.0.0.1:${port}/api/agent/logs/files/${pathSuffix}`);
}

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

async function readLogContent(response: Response): Promise<ApiSuccessResponse<MaaLogFileContent>> {
  return readBody<ApiSuccessResponse<MaaLogFileContent>>(response);
}

async function readErrorBody(response: Response): Promise<ApiErrorResponse> {
  const body = await readBody<ApiErrorResponse>(response);
  assert.equal(body.success, false);
  return body;
}

afterEach(async () => {
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

describe('GET /api/agent/logs/files/:filePath single URL decoding', () => {
  it('reads nested files requested with literal slashes', async () => {
    const response = await listenAndFetch(NESTED_LOG);
    assert.equal(response.status, 200);
    const body = await readLogContent(response);
    assert.equal(body.success, true);
    assert.equal(body.data.content, 'nested run log');
  });

  it('decodes encoded path separators exactly once', async () => {
    // 客户端形态：encodeURIComponent 把目录分隔符与文件名一起编码
    const response = await listenAndFetch(encodeURIComponent(NESTED_LOG));
    assert.equal(response.status, 200);
    const body = await readLogContent(response);
    assert.equal(body.data.content, 'nested run log');
  });

  it('resolves normalized traversal that stays inside the log directory', async () => {
    const response = await listenAndFetch(encodeURIComponent(join(maaLogDir, 'sub', '..', '100%.log')));
    assert.equal(response.status, 200);
    const body = await readLogContent(response);
    assert.equal(body.data.content, 'trailing percent log');
  });

  it('reads file names ending with a bare percent sign', async () => {
    // encodeURIComponent('100%.log') 产生 '...%2F100%25.log'；
    // 二次解码会在这里抛 URIError 并退化为 500，回归锁定单次解码后的 200。
    const response = await listenAndFetch(encodeURIComponent(TRAILING_PERCENT_LOG));
    assert.equal(response.status, 200);
    const body = await readLogContent(response);
    assert.equal(body.data.content, 'trailing percent log');
  });

  it('keeps literal %20 file names instead of double-decoding', async () => {
    // encodeURIComponent('a%20b.log') 产生 '...%2Fa%2520b.log'；
    // 二次解码会把它错转成 'a b.log'，回归锁定字面文件名不被转换。
    const response = await listenAndFetch(encodeURIComponent(LITERAL_PERCENT_LOG));
    assert.equal(response.status, 200);
    const body = await readLogContent(response);
    assert.equal(body.data.content, 'literal percent-twenty log');
  });

  it('keeps encoded-space file names readable', async () => {
    const response = await listenAndFetch(encodeURIComponent(SPACE_LOG));
    assert.equal(response.status, 200);
    const body = await readLogContent(response);
    assert.equal(body.data.content, 'space log');
  });
});

describe('GET /api/agent/logs/files file listing round trip', () => {
  it('lists nested and percent-named files so their paths can be read back', async () => {
    const port = await listen(createLaPlumaApp({ env: {}, signalingGateway: stubSignalingGateway() }));
    const response = await fetch(`http://127.0.0.1:${port}/api/agent/logs/files`);
    assert.equal(response.status, 200);
    const body = await readBody<ApiSuccessResponse<MaaLogFileEntry[]>>(response);
    assert.equal(body.success, true);
    const names = body.data.map(file => file.name);
    assert.ok(names.includes('sub/run-1.log'));
    assert.ok(names.includes('100%.log'));
    assert.ok(names.includes('a%20b.log'));
  });
});

describe('GET /api/agent/logs/files/:filePath path boundary', () => {
  // 越界与失败走统一错误出口：普通 Error 无公开状态，按现有契约返回 500 与稳定错误码
  async function assertRejected(pathSuffix: string, expectedStatus = 500): Promise<ApiErrorResponse> {
    const response = await listenAndFetch(pathSuffix);
    assert.equal(response.status, expectedStatus);
    const body = await readErrorBody(response);
    assert.equal(body.success, false);
    return body;
  }

  it('rejects absolute paths outside the log directory', async () => {
    const body = await assertRejected(encodeURIComponent(OUTSIDE_LOG));
    assert.equal(body.error.code, 'AGENT_INTERNAL_ERROR');
  });

  it('rejects symlinks resolving outside the log directory', async () => {
    const body = await assertRejected(encodeURIComponent(join(maaLogDir, 'escape.log')));
    assert.equal(body.error.code, 'AGENT_INTERNAL_ERROR');
  });

  it('rejects directory symlinks escaping the log directory', async () => {
    const body = await assertRejected(encodeURIComponent(join(maaLogDir, 'sub-alias', 'secret.log')));
    assert.equal(body.error.code, 'AGENT_INTERNAL_ERROR');
  });

  it('rejects non-log files inside the log directory', async () => {
    const body = await assertRejected(encodeURIComponent(join(maaLogDir, 'notes.txt')));
    assert.equal(body.error.code, 'AGENT_INTERNAL_ERROR');
  });

  it('rejects missing files', async () => {
    const body = await assertRejected(encodeURIComponent(join(maaLogDir, 'missing.log')));
    assert.equal(body.error.code, 'AGENT_INTERNAL_ERROR');
  });

  it('maps undecodable percent sequences in the path to a stable 400', async () => {
    // 客户端必须对 % 做百分号编码（encodeURIComponent 会转成 %25）；
    // 未编码的畸形序列由 Express 解码失败映射为稳定 JSON 400。
    const body = await assertRejected('100%.log', 400);
    assert.equal(body.error.code, 'AGENT_REQUEST_PATH_INVALID');
  });
});
