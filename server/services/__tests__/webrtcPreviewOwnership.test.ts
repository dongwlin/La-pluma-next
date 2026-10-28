import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { arch, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, describe, it } from 'node:test';
import { createRuntimeLifecycle } from '../runtimeLifecycleService.ts';
import type { WebrtcRuntimeError, WebrtcRunningStatus } from '../webrtcService.ts';

const ENV_KEYS = [
  'LA_PLUMA_WEBRTC_DIR',
  'LA_PLUMA_WEBRTC_PORT',
  'LA_PLUMA_WEBRTC_TURN_PORT',
  'LA_PLUMA_WEBRTC_TURN_SERVER_PATH',
  'LA_PLUMA_WEBRTC_REQUEST_TIMEOUT_MS',
  'LA_PLUMA_WEBRTC_SERVER_START_TIMEOUT_MS',
  'LA_PLUMA_WEBRTC_AGENT_START_TIMEOUT_MS',
  'LA_PLUMA_WEBRTC_START_POLL_INTERVAL_MS',
  'LA_PLUMA_WEBRTC_VIEWER_IDLE_GRACE_MS',
  'TEST_WEBRTC_DEVICES_FILE',
  'TEST_WEBRTC_SERVER_COUNT_FILE',
  'TEST_WEBRTC_SERVER_ARGS_FILE',
  'TEST_WEBRTC_SERVER_PID_FILE',
  'TEST_WEBRTC_TURN_PID_FILE',
  'TEST_WEBRTC_AGENT_COUNT_FILE',
  'TEST_WEBRTC_AGENT_PID_FILE',
  'TEST_WEBRTC_SLOW_PID_FILE',
  'TEST_WEBRTC_PKILL_FILE'
];

interface FixtureFiles {
  devices: string;
  serverCount: string;
  serverArgs: string;
  serverPid: string;
  turnPid: string;
  agentCount: string;
  agentPid: string;
  slowPid: string;
  pkill: string;
  externalCount: string;
  externalArgs: string;
  externalPid: string;
  externalTurnPid: string;
  fakeAdb: string;
}

interface WebrtcFixture {
  dir: string;
  files: FixtureFiles;
  port: number;
  turnPort: number;
  service: typeof import('../webrtcService.ts');
  serverPath: string;
  turnPath: string;
}

const ORIGINAL_ENV = new Map<string, string | undefined>(ENV_KEYS.map(key => [key, process.env[key]]));
const fixtures: WebrtcFixture[] = [];
let fixtureSequence = 0;

function readErrorCode(error: unknown): string | undefined {
  return (error as WebrtcRuntimeError | null)?.code;
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('监听端口获取失败');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

async function countLines(filePath: string): Promise<number> {
  try {
    return (await readFile(filePath, 'utf8')).trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  check: () => boolean | Promise<boolean>,
  message = 'condition did not settle'
): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, message);
    await delay(10);
  }
}

async function readPid(filePath: string): Promise<number> {
  return Number(await readFile(filePath, 'utf8'));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

function createServerScript(): string {
  return `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')

fs.appendFileSync(process.env.TEST_WEBRTC_SERVER_COUNT_FILE, 'spawn\\n')
fs.writeFileSync(process.env.TEST_WEBRTC_SERVER_ARGS_FILE, JSON.stringify(process.argv.slice(2)))
fs.writeFileSync(process.env.TEST_WEBRTC_SERVER_PID_FILE, String(process.pid))

const server = http.createServer((request, response) => {
  if (request.url === '/api/login' && request.method === 'POST') {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ token: 'fixture-token' }))
    return
  }
  if (request.url === '/devices') {
    if (request.headers.authorization !== 'Bearer fixture-token') {
      response.statusCode = 401
      response.end('unauthorized')
      return
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(fs.readFileSync(process.env.TEST_WEBRTC_DEVICES_FILE, 'utf8'))
    return
  }
  response.statusCode = 200
  response.end('ready')
})

setTimeout(() => server.listen(Number(process.env.PORT), '127.0.0.1'), 60)
process.on('SIGTERM', () => {
  server.closeAllConnections()
  server.close(() => process.exit(0))
})
`;
}

function createTurnScript(): string {
  return `#!/usr/bin/env node
const fs = require('node:fs')
const net = require('node:net')

fs.writeFileSync(process.env.TEST_WEBRTC_TURN_PID_FILE, String(process.pid))
const port = Number(process.argv[process.argv.indexOf('-p') + 1])
setTimeout(() => {
  const server = net.createServer(socket => socket.end())
  server.listen(port, '0.0.0.0')
}, 60)
process.on('SIGTERM', () => process.exit(0))
`;
}

function createAgentScript(): string {
  return `#!/bin/bash
printf 'spawn\\n' >> "$TEST_WEBRTC_AGENT_COUNT_FILE"
printf '%s' "$$" > "$TEST_WEBRTC_AGENT_PID_FILE"
if [ "$1" = "slow-address" ]; then
  printf '%s' "$$" > "$TEST_WEBRTC_SLOW_PID_FILE"
  sleep 5
  exit 0
fi
sleep 0.15
printf '[{"device_id":"%s"}]' "$3" > "$TEST_WEBRTC_DEVICES_FILE"
`;
}

function createFakeAdbScript(): string {
  return `#!/bin/bash
if [ "$1" = "devices" ]; then
  printf 'List of devices attached\\nfixture-device\\tdevice\\nsecond-address\\tdevice\\nslow-address\\tdevice\\n'
  exit 0
fi
if [[ "$*" == *"pkill -f cloudphone-agent"* ]]; then
  printf 'pkill\\n' >> "$TEST_WEBRTC_PKILL_FILE"
  printf '[]' > "$TEST_WEBRTC_DEVICES_FILE"
  exit 0
fi
if [[ "$*" == *"ps -A | grep cloudphone-agent"* ]] && ! grep -q '^\\[\\]$' "$TEST_WEBRTC_DEVICES_FILE"; then
  echo cloudphone-agent
fi
`;
}

async function createFixture(): Promise<WebrtcFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'la-pluma-webrtc-ownership-'));
  const binaryDir = join(dir, 'bin', `${platform()}_${arch() === 'arm64' ? 'arm64' : 'amd64'}`);
  const assetsDir = join(dir, 'assets', 'v1');
  const agentDir = join(dir, 'agentd');
  await Promise.all([
    mkdir(binaryDir, { recursive: true }),
    mkdir(assetsDir, { recursive: true }),
    mkdir(agentDir, { recursive: true })
  ]);

  const files: FixtureFiles = {
    devices: join(dir, 'devices.json'),
    serverCount: join(dir, 'server-count.log'),
    serverArgs: join(dir, 'server-args.json'),
    serverPid: join(dir, 'server.pid'),
    turnPid: join(dir, 'turn.pid'),
    agentCount: join(dir, 'agent-count.log'),
    agentPid: join(dir, 'agent.pid'),
    slowPid: join(dir, 'slow.pid'),
    pkill: join(dir, 'pkill.log'),
    externalCount: join(dir, 'external-server-count.log'),
    externalArgs: join(dir, 'external-server-args.json'),
    externalPid: join(dir, 'external-server.pid'),
    externalTurnPid: join(dir, 'external-turn.pid'),
    fakeAdb: join(dir, 'adb')
  };
  await writeFile(files.devices, '[]');

  const serverPath = join(binaryDir, 'webrtc-signaling');
  const turnPath = join(dir, 'turnserver');
  const runScript = join(agentDir, 'run.sh');
  await Promise.all([
    writeFile(serverPath, createServerScript()),
    writeFile(turnPath, createTurnScript()),
    writeFile(runScript, createAgentScript()),
    writeFile(files.fakeAdb, createFakeAdbScript())
  ]);
  await Promise.all([
    chmod(serverPath, 0o755),
    chmod(turnPath, 0o755),
    chmod(runScript, 0o755),
    chmod(files.fakeAdb, 0o755)
  ]);

  const port = await getAvailablePort();
  const turnPort = await getAvailablePort();
  Object.assign(process.env, {
    LA_PLUMA_WEBRTC_DIR: dir,
    LA_PLUMA_WEBRTC_PORT: String(port),
    LA_PLUMA_WEBRTC_TURN_PORT: String(turnPort),
    LA_PLUMA_WEBRTC_TURN_SERVER_PATH: turnPath,
    LA_PLUMA_WEBRTC_REQUEST_TIMEOUT_MS: '200',
    LA_PLUMA_WEBRTC_SERVER_START_TIMEOUT_MS: '3000',
    LA_PLUMA_WEBRTC_AGENT_START_TIMEOUT_MS: '5000',
    LA_PLUMA_WEBRTC_START_POLL_INTERVAL_MS: '20',
    LA_PLUMA_WEBRTC_VIEWER_IDLE_GRACE_MS: '30',
    TEST_WEBRTC_DEVICES_FILE: files.devices,
    TEST_WEBRTC_SERVER_COUNT_FILE: files.serverCount,
    TEST_WEBRTC_SERVER_ARGS_FILE: files.serverArgs,
    TEST_WEBRTC_SERVER_PID_FILE: files.serverPid,
    TEST_WEBRTC_TURN_PID_FILE: files.turnPid,
    TEST_WEBRTC_AGENT_COUNT_FILE: files.agentCount,
    TEST_WEBRTC_AGENT_PID_FILE: files.agentPid,
    TEST_WEBRTC_SLOW_PID_FILE: files.slowPid,
    TEST_WEBRTC_PKILL_FILE: files.pkill
  });

  const service = await import(`../webrtcService.ts?webrtc-ownership=${++fixtureSequence}`);
  const fixture = { dir, files, port, turnPort, service, serverPath, turnPath };
  fixtures.push(fixture);
  return fixture;
}

interface ExternalInfrastructure {
  serverPid: number;
  turnPid: number;
  stop(): Promise<void>;
}

async function startExternalInfrastructure(fixture: WebrtcFixture): Promise<ExternalInfrastructure> {
  const externalServer = spawn(fixture.serverPath, [], {
    env: {
      ...process.env,
      PORT: String(fixture.port),
      TEST_WEBRTC_SERVER_COUNT_FILE: fixture.files.externalCount,
      TEST_WEBRTC_SERVER_ARGS_FILE: fixture.files.externalArgs,
      TEST_WEBRTC_SERVER_PID_FILE: fixture.files.externalPid
    },
    stdio: 'ignore'
  });
  const externalTurn = spawn(fixture.turnPath, ['-p', String(fixture.turnPort)], {
    env: {
      ...process.env,
      TEST_WEBRTC_TURN_PID_FILE: fixture.files.externalTurnPid
    },
    stdio: 'ignore'
  });
  await fixture.service.waitForWebrtcServerReady({ timeoutMs: 3000 });
  await fixture.service.waitForTurnServerReady({ timeoutMs: 3000 });
  const serverPid = await readPid(fixture.files.externalPid);
  const turnPid = await readPid(fixture.files.externalTurnPid);
  return {
    serverPid,
    turnPid,
    async stop() {
      externalServer.kill('SIGTERM');
      externalTurn.kill('SIGTERM');
      await Promise.all([
        new Promise<void>(resolve => externalServer.once('exit', () => resolve())),
        new Promise<void>(resolve => externalTurn.once('exit', () => resolve()))
      ]);
    }
  };
}

after(async () => {
  for (const fixture of fixtures) {
    const pidFiles = [
      fixture.files.serverPid,
      fixture.files.turnPid,
      fixture.files.agentPid,
      fixture.files.slowPid,
      fixture.files.externalPid,
      fixture.files.externalTurnPid
    ];
    for (const pidFile of pidFiles) {
      try {
        process.kill(await readPid(pidFile), 'SIGTERM');
      } catch {
        // The fixture process may not have started when an earlier assertion failed.
      }
    }
    await rm(fixture.dir, { recursive: true, force: true });
  }
  for (const [key, value] of ORIGINAL_ENV) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('WebRTC preview ownership and shutdown', () => {
  it('leaves a pre-existing server, TURN listener and device agent untouched', async () => {
    const fixture = await createFixture();
    const { service, files } = fixture;
    await writeFile(files.devices, JSON.stringify([{ device_id: 'preview-device' }]));
    const external = await startExternalInfrastructure(fixture);

    try {
      const status = await service.getWebrtcStatus('fixture-device', files.fakeAdb);
      assert.equal(status.serverRunning, true);
      assert.equal(status.turnRunning, false);
      assert.deepEqual(status.ownership, {
        server: 'external',
        turn: 'external',
        agent: 'external'
      });

      const stoppedServer = await service.stopWebrtcServer('fixture-device', files.fakeAdb);
      assert.deepEqual(stoppedServer.released, []);
      assert.deepEqual(stoppedServer.ownership, {
        server: 'external',
        turn: 'external',
        agent: 'external'
      });

      const stoppedAgent = await service.stopWebrtcAgent('fixture-device', files.fakeAdb);
      assert.deepEqual(stoppedAgent.released, []);

      await delay(100);
      assert.equal(isAlive(external.serverPid), true);
      assert.equal(isAlive(external.turnPid), true);
      assert.equal(await countLines(files.serverCount), 0);
      assert.equal(await countLines(files.agentCount), 0);
      assert.equal(await countLines(files.pkill), 0);

      const lifecycle = createRuntimeLifecycle({
        logger: { warn() {}, error() {} },
        closeDeadlineMs: 2000
      });
      service.attachWebrtcPreviewToLifecycle(lifecycle);
      await lifecycle.start();
      const summary = await lifecycle.close('test');
      assert.equal(summary.ok, true);
      await delay(100);
      assert.equal(isAlive(external.serverPid), true);
      assert.equal(isAlive(external.turnPid), true);
      assert.equal(await countLines(files.pkill), 0);
    } finally {
      await external.stop();
    }
  });

  it('stops only the server, TURN and device agent it started', async () => {
    const fixture = await createFixture();
    const { service, files } = fixture;

    const started = await service.startWebrtc('fixture-device', 'preview-device', files.fakeAdb);
    assert.equal(started.agentRunning, true);
    assert.deepEqual(started.ownership, {
      server: 'managed',
      turn: 'managed',
      agent: 'managed'
    });
    assert.equal(await countLines(files.serverCount), 1);
    assert.equal(await countLines(files.agentCount), 1);
    const serverPid = await readPid(files.serverPid);
    const turnPid = await readPid(files.turnPid);

    const stopped = await service.stopWebrtc('fixture-device', files.fakeAdb);
    assert.equal(stopped.stopped, true);
    assert.deepEqual([...stopped.released].sort(), ['device-agent', 'server', 'turn']);
    await waitUntil(() => !isAlive(serverPid), 'owned signaling server did not stop');
    await waitUntil(() => !isAlive(turnPid), 'owned TURN did not stop');

    const status = await service.getWebrtcStatus('fixture-device', files.fakeAdb);
    assert.deepEqual(status.ownership, { server: 'none', turn: 'none', agent: 'none' });
    assert.equal(await countLines(files.pkill), 1);
  });

  it('aborts a start that is in flight when close begins and terminates its deployment', async () => {
    const fixture = await createFixture();
    const { service, files } = fixture;
    const serverStatus = await service.startWebrtcServer('fixture-device', files.fakeAdb);
    assert.equal(serverStatus.ownership.server, 'managed');

    const lifecycle = createRuntimeLifecycle({
      logger: { warn() {}, error() {} },
      closeDeadlineMs: 2000
    });
    assert.deepEqual(service.attachWebrtcPreviewToLifecycle(lifecycle), { attached: true, duplicate: false });
    assert.deepEqual(service.attachWebrtcPreviewToLifecycle(lifecycle), { attached: true, duplicate: true });
    await lifecycle.start();

    const serverPid = await readPid(files.serverPid);
    const turnPid = await readPid(files.turnPid);
    const pending = service.startWebrtcAgent('slow-address', 'slow-device', files.fakeAdb);
    // 不立即 await：慢部署仍在运行，关闭必须先中止它，而不是等它自行结束。
    const settled: Promise<{ value?: WebrtcRunningStatus; error?: unknown }> = pending.then(
      value => ({ value }),
      error => ({ error })
    );
    await waitUntil(() => fileExists(files.slowPid), 'agent deployment did not start');
    const deploymentPid = await readPid(files.slowPid);

    const startedAt = Date.now();
    const summary = await lifecycle.close('test');
    const elapsed = Date.now() - startedAt;

    // 关闭等待队列收敛，但不会等待被中止的慢部署自行结束；子进程必须被终止。
    const outcome = await settled;
    assert.equal(outcome.value, undefined);
    assert.equal(readErrorCode(outcome.error), 'WEBRTC_PREVIEW_CLOSED');
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.steps.map(step => step.name), ['webrtc-preview']);
    assert.ok(elapsed < 2000, `close waited ${elapsed}ms for the aborted start`);
    await waitUntil(() => !isAlive(deploymentPid), 'aborted agent deployment was not terminated');
    await waitUntil(() => !isAlive(serverPid), 'close did not terminate the owned signaling server');
    await waitUntil(() => !isAlive(turnPid), 'close did not terminate the owned TURN');

    const repeated = await lifecycle.close('again');
    assert.equal(repeated, summary);
    await assert.rejects(
      service.startWebrtc('fixture-device', 'preview-device', files.fakeAdb),
      error => readErrorCode(error) === 'WEBRTC_PREVIEW_CLOSED'
    );
    assert.equal(await countLines(files.serverCount), 1);
  });

  it('cancels pending viewer cleanup and releases owned children on close', async () => {
    const fixture = await createFixture();
    const { service, files } = fixture;
    await service.startWebrtc('fixture-device', 'preview-device', files.fakeAdb);
    const serverPid = await readPid(files.serverPid);
    const viewer = service.registerWebrtcViewer('preview-device');
    await viewer.ready;

    const lifecycle = createRuntimeLifecycle({
      logger: { warn() {}, error() {} },
      closeDeadlineMs: 2000
    });
    service.attachWebrtcPreviewToLifecycle(lifecycle);
    await lifecycle.start();

    // 释放最后一个 viewer 会排定自动回收；关闭必须取消该计时器而不是触发停止。
    viewer.release();
    const summary = await lifecycle.close('test');
    assert.equal(summary.ok, true);

    await waitUntil(() => !isAlive(serverPid), 'owned signaling server did not stop on close');
    await delay(120);
    assert.equal(await countLines(files.pkill), 0);
    assert.equal(await countLines(files.agentCount), 1);
    const status = await service.getWebrtcStatus('fixture-device', files.fakeAdb);
    assert.equal(status.ownership.server, 'none');
    assert.equal(status.ownership.turn, 'none');
  });
});
