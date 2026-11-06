import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createLaPlumaApp } from '../app.ts';
import { createInfrastScheduleService } from '../services/infrastScheduleService.ts';
import type { InfrastScheduleService } from '../services/infrastScheduleService.ts';
import { loggerManager } from '../utils/logger.ts';

loggerManager.getLogger('Api').enableConsole = false;

const servers: Server[] = [];
const tempDirs: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) assert.fail(`${label} 必须是 JSON 对象`);
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) assert.fail(`${label} 必须是数组`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') assert.fail(`${label} 必须是字符串`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') assert.fail(`${label} 必须是布尔值`);
  return value;
}

interface ApiEnvelope {
  success: boolean;
  message: string;
  data: unknown;
  error: { code: string; retryable: boolean } | null;
}

function parseEnvelope(body: unknown): ApiEnvelope {
  const record = requireRecord(body, '响应');
  const errorRecord = record.error === undefined
    ? null
    : requireRecord(record.error, 'error');
  return {
    success: requireBoolean(record.success, 'success'),
    message: requireString(record.message, 'message'),
    data: record.data,
    error: errorRecord
      ? {
          code: requireString(errorRecord.code, 'error.code'),
          retryable: requireBoolean(errorRecord.retryable, 'error.retryable')
        }
      : null
  };
}

async function readEnvelope(response: Response): Promise<ApiEnvelope> {
  return parseEnvelope(await response.json());
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

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

function documentUrl(port: number, name: string): string {
  return agentUrl(port, `/infrast-schedules/document?name=${encodeURIComponent(name)}`);
}

async function putDocument(port: number, body: unknown): Promise<Response> {
  return fetch(agentUrl(port, '/infrast-schedules/document'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

function scheduleDocumentFixture(): Record<string, unknown> {
  return {
    title: '243 排班',
    description: '测试用排班表',
    author: '测试作者',
    id: 1779034959998915,
    planTimes: '3班',
    scheduleType: { planTimes: 3, trading: 2 },
    layout: [{ type: 'control', level: 5 }],
    metadata: { extensionVersion: '1.0', generator: { id: 'fixture', name: 'fixture' } },
    plans: [{
      name: '早班',
      Fiammetta: { enable: false, target: '', order: 'pre' },
      drones: { enable: true, room: 'manufacture', index: 1, order: 'pre' },
      groups: [{ name: '古+银', operators: ['古米', '银灰', '梅'] }],
      period: [['22:00', '23:59']],
      unknownPlanExtension: 'keep',
      rooms: {
        manufacture: [{
          operators: ['芬', '稀音'],
          sort: true,
          product: 'Battle Record',
          unknownRoomExtension: { nested: true }
        }],
        trading: [{ skip: true, product: 'Future Product' }],
        training: [{ operatorsA: ['杜宾'], operatorsB: ['银灰'] }],
        recycle: [{ operators: ['克洛丝'], product: 'LMD' }],
        futureFacility: [{ operators: ['未来干员'] }]
      }
    }]
  };
}

async function startAppWithService(
  rootDir: string,
  service: InfrastScheduleService = createInfrastScheduleService({ rootDir }),
  env: Record<string, string> = {}
): Promise<{ port: number; service: InfrastScheduleService }> {
  const app = createLaPlumaApp({ env, infrastScheduleService: service });
  const port = await listen(app);
  return { port, service };
}

afterEach(async () => {
  let server = servers.pop();
  while (server) {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server?.close(() => resolve()));
    server = servers.pop();
  }
  let dir = tempDirs.pop();
  while (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = tempDirs.pop();
  }
});

describe('infrast schedule routes over real HTTP', () => {
  it('serves the injected schedule directory listing', async () => {
    const rootDir = await makeTempDir('la-pluma-infrast-http-');
    const { port } = await startAppWithService(rootDir);

    const response = await fetch(agentUrl(port, '/infrast-schedules'));
    assert.equal(response.status, 200);
    const envelope = await readEnvelope(response);
    assert.equal(envelope.success, true);
    assert.equal(envelope.message, '已获取基建排班列表');
    const data = requireRecord(envelope.data, 'data');
    assert.equal(data.directory, rootDir);
    assert.deepEqual(data.schedules, []);
  });

  it('round-trips a saved document including unknown protocol fields', async () => {
    const rootDir = await makeTempDir('la-pluma-infrast-http-');
    const { port } = await startAppWithService(rootDir);
    const document = scheduleDocumentFixture();

    const save = await putDocument(port, { name: 'nested/243.json', document });
    assert.equal(save.status, 200);
    const saveEnvelope = await readEnvelope(save);
    assert.equal(saveEnvelope.success, true);
    assert.equal(saveEnvelope.message, '基建排班文件已保存');
    assert.deepEqual(saveEnvelope.data, { name: 'nested/243.json', planCount: 1 });

    const stored = JSON.parse(await readFile(join(rootDir, 'nested/243.json'), 'utf-8'));
    assert.deepEqual(stored, document);

    const list = await fetch(agentUrl(port, '/infrast-schedules'));
    assert.equal(list.status, 200);
    const listEnvelope = await readEnvelope(list);
    const listData = requireRecord(listEnvelope.data, 'data');
    assert.equal(listData.directory, rootDir);
    const schedules = requireArray(listData.schedules, 'schedules');
    assert.equal(schedules.length, 1);
    const schedule = requireRecord(schedules[0], 'schedule');
    assert.equal(schedule.name, 'nested/243.json');
    assert.equal(schedule.title, '243 排班');
    assert.equal(schedule.planCount, 1);
    assert.equal(schedule.valid, true);

    const read = await fetch(documentUrl(port, 'nested/243.json'));
    assert.equal(read.status, 200);
    const readEnvelopeBody = await readEnvelope(read);
    assert.equal(readEnvelopeBody.success, true);
    assert.equal(readEnvelopeBody.message, '已获取基建排班文件');
    const readData = requireRecord(readEnvelopeBody.data, 'data');
    assert.equal(readData.name, 'nested/243.json');
    assert.deepEqual(readData.document, document);
  });

  it('rejects invalid requests with structured errors before touching storage', async () => {
    const rootDir = await makeTempDir('la-pluma-infrast-http-');
    const { port } = await startAppWithService(rootDir);
    const document = scheduleDocumentFixture();

    const noName = await fetch(agentUrl(port, '/infrast-schedules/document'));
    assert.equal(noName.status, 400);
    const noNameEnvelope = await readEnvelope(noName);
    assert.equal(noNameEnvelope.success, false);
    assert.equal(noNameEnvelope.error?.code, 'AGENT_INFRASTRUCT_SCHEDULE_INVALID');
    assert.equal(noNameEnvelope.error?.retryable, false);
    assert.match(noNameEnvelope.message, /排班文件名必须是字符串/);

    const escaped = await fetch(documentUrl(port, '../escape.json'));
    assert.equal(escaped.status, 400);
    assert.equal((await readEnvelope(escaped)).error?.code, 'AGENT_INFRASTRUCT_SCHEDULE_INVALID');

    const missing = await fetch(documentUrl(port, 'missing.json'));
    assert.equal(missing.status, 404);
    const missingEnvelope = await readEnvelope(missing);
    assert.equal(missingEnvelope.error?.code, 'AGENT_INFRASTRUCT_SCHEDULE_NOT_FOUND');
    assert.equal(missingEnvelope.error?.retryable, false);
    assert.match(missingEnvelope.message, /未找到基建排班文件/);

    const missingName = await putDocument(port, {});
    assert.equal(missingName.status, 400);
    assert.match((await readEnvelope(missingName)).message, /缺少 name 参数/);

    const missingDocument = await putDocument(port, { name: 'plan.json' });
    assert.equal(missingDocument.status, 400);
    assert.match((await readEnvelope(missingDocument)).message, /缺少 document 参数/);

    const arrayBody = await putDocument(port, [1, 2, 3]);
    assert.equal(arrayBody.status, 400);
    assert.match((await readEnvelope(arrayBody)).message, /请求体必须是 JSON 对象/);

    const invalidDocument = await putDocument(port, { name: 'plan.json', document: { plans: [] } });
    assert.equal(invalidDocument.status, 400);
    const invalidDocumentEnvelope = await readEnvelope(invalidDocument);
    assert.equal(invalidDocumentEnvelope.error?.code, 'AGENT_INFRASTRUCT_SCHEDULE_INVALID');
    assert.match(invalidDocumentEnvelope.message, /plans 不能为空/);

    const wrongExtension = await putDocument(port, { name: 'plan.txt', document });
    assert.equal(wrongExtension.status, 400);
    assert.match((await readEnvelope(wrongExtension)).message, /\.json/);

    const brokenJson = await putDocument(port, '{"broken');
    assert.equal(brokenJson.status, 400);
    assert.equal((await readEnvelope(brokenJson)).error?.code, 'AGENT_REQUEST_BODY_INVALID');

    const list = await fetch(agentUrl(port, '/infrast-schedules'));
    const listEnvelope = await readEnvelope(list);
    assert.deepEqual(requireRecord(listEnvelope.data, 'data').schedules, []);
  });

  it('lists broken and invalid files as invalid and refuses to read broken JSON', async () => {
    const rootDir = await makeTempDir('la-pluma-infrast-http-');
    const { port } = await startAppWithService(rootDir);
    await writeFile(join(rootDir, 'broken.json'), '{"plans": [');
    await writeFile(join(rootDir, 'invalid.json'), JSON.stringify({ plans: [] }));

    const list = await fetch(agentUrl(port, '/infrast-schedules'));
    assert.equal(list.status, 200);
    const listEnvelope = await readEnvelope(list);
    const schedules = requireArray(requireRecord(listEnvelope.data, 'data').schedules, 'schedules');
    const byName = new Map(
      schedules.map(entry => {
        const record = requireRecord(entry, 'schedule');
        return [requireString(record.name, 'schedule.name'), record];
      })
    );
    assert.equal(byName.get('broken.json')?.valid, false);
    assert.equal(byName.get('invalid.json')?.valid, false);

    const brokenRead = await fetch(documentUrl(port, 'broken.json'));
    assert.equal(brokenRead.status, 400);
    const brokenEnvelope = await readEnvelope(brokenRead);
    assert.equal(brokenEnvelope.error?.code, 'AGENT_INFRASTRUCT_SCHEDULE_INVALID');
    assert.match(brokenEnvelope.message, /不是有效的 JSON/);

    const invalidRead = await fetch(documentUrl(port, 'invalid.json'));
    assert.equal(invalidRead.status, 200);
    const invalidEnvelope = await readEnvelope(invalidRead);
    assert.deepEqual(requireRecord(invalidEnvelope.data, 'data').document, { plans: [] });
  });

  it('maps an injected filesystem failure to a retryable IO error', async () => {
    const rootDir = await makeTempDir('la-pluma-infrast-http-');
    await writeFile(join(rootDir, 'existing.json'), JSON.stringify({ plans: [{ rooms: {} }] }));
    const failingService = createInfrastScheduleService({
      rootDir,
      fileSystem: {
        readTextFile: async () => {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
      }
    });
    const { port } = await startAppWithService(rootDir, failingService);

    const response = await fetch(documentUrl(port, 'existing.json'));
    assert.equal(response.status, 500);
    const envelope = await readEnvelope(response);
    assert.equal(envelope.success, false);
    assert.equal(envelope.error?.code, 'AGENT_INFRASTRUCT_SCHEDULE_IO_FAILED');
    assert.equal(envelope.error?.retryable, true);
    assert.match(envelope.message, /读取基建排班文件失败/);
  });

  it('keeps the schedule routes behind the optional API token', async () => {
    const rootDir = await makeTempDir('la-pluma-infrast-http-');
    const { port } = await startAppWithService(
      rootDir,
      createInfrastScheduleService({ rootDir }),
      { LA_PLUMA_TOKEN: 'infrast-secret' }
    );

    const unauthorized = await fetch(agentUrl(port, '/infrast-schedules'));
    assert.equal(unauthorized.status, 401);
    assert.equal((await readEnvelope(unauthorized)).error?.code, 'AGENT_AUTH_REQUIRED');

    const authorized = await fetch(agentUrl(port, '/infrast-schedules'), {
      headers: { authorization: 'Bearer infrast-secret' }
    });
    assert.equal(authorized.status, 200);
    const envelope = await readEnvelope(authorized);
    assert.equal(envelope.success, true);
    assert.deepEqual(requireRecord(envelope.data, 'data').schedules, []);
  });
});
