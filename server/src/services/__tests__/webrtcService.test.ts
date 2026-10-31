import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { arch, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { WebrtcRuntimeError, WebrtcStopSummary, WebrtcRunningStatus } from '../webrtcService.ts';

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
  'LA_PLUMA_WEBRTC_USERNAME',
  'LA_PLUMA_WEBRTC_PASSWORD',
  'TEST_WEBRTC_DEVICES_FILE',
  'TEST_WEBRTC_SERVER_COUNT_FILE',
  'TEST_WEBRTC_SERVER_ARGS_FILE',
  'TEST_WEBRTC_LOGIN_BODY_FILE',
  'TEST_WEBRTC_AGENT_COUNT_FILE',
  'TEST_WEBRTC_AGENT_PID_FILE',
  'TEST_WEBRTC_STOP_STARTED_FILE',
  'TEST_WEBRTC_SERVER_PID_FILE',
  'TEST_WEBRTC_TURN_PID_FILE'
];

/** 断言里按错误形状读取字段：assert.rejects 的入参是 unknown。 */
function readError(error: unknown): WebrtcRuntimeError {
  return error as WebrtcRuntimeError;
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

async function openFixtureLogDescriptors(logPaths: string[]): Promise<string[]> {
  const openTargets: string[] = [];
  for (const entry of await readdir('/dev/fd')) {
    try {
      const target = await readlink(`/dev/fd/${entry}`);
      if (logPaths.includes(target)) openTargets.push(target);
    } catch {
      // File descriptors can close while /dev/fd is being inspected.
    }
  }
  return openTargets;
}

describe('WebRTC startup readiness', () => {
  let fixtureDir: string;
  let devicesFile: string;
  let serverCountFile: string;
  let serverArgsFile: string;
  let loginBodyFile: string;
  let loginResponseFile: string;
  let agentCountFile: string;
  let agentPidFile: string;
  let serverPidFile: string;
  let turnPidFile: string;
  let turnPort: number;
  let fakeAdbPath: string;
  let service: typeof import('../webrtcService.ts');
  const previousEnv = new Map<string, string | undefined>();

  before(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'la-pluma-webrtc-'));
    const binaryDir = join(fixtureDir, 'bin', `${platform()}_${arch() === 'arm64' ? 'arm64' : 'amd64'}`);
    const assetsDir = join(fixtureDir, 'assets', 'v1');
    const agentDir = join(fixtureDir, 'agentd');
    await Promise.all([
      mkdir(binaryDir, { recursive: true }),
      mkdir(assetsDir, { recursive: true }),
      mkdir(agentDir, { recursive: true })
    ]);

    devicesFile = join(fixtureDir, 'devices.json');
    serverCountFile = join(fixtureDir, 'server-count.log');
    serverArgsFile = join(fixtureDir, 'server-args.json');
    loginBodyFile = join(fixtureDir, 'login-body.json');
    loginResponseFile = join(fixtureDir, 'login-response.json');
    agentCountFile = join(fixtureDir, 'agent-count.log');
    agentPidFile = join(fixtureDir, 'agent.pid');
    serverPidFile = join(fixtureDir, 'server.pid');
    turnPidFile = join(fixtureDir, 'turn.pid');
    fakeAdbPath = join(fixtureDir, 'adb');
    await writeFile(devicesFile, '[]');

    const signalingPath = join(binaryDir, 'webrtc-signaling');
    await writeFile(signalingPath, `#!/usr/bin/env node
const fs = require('node:fs')
const http = require('node:http')

const LOGIN_RESPONSE_FILE = ${JSON.stringify(loginResponseFile)}

fs.appendFileSync(process.env.TEST_WEBRTC_SERVER_COUNT_FILE, 'spawn\\n')
fs.writeFileSync(process.env.TEST_WEBRTC_SERVER_ARGS_FILE, JSON.stringify(process.argv.slice(2)))
fs.writeFileSync(process.env.TEST_WEBRTC_SERVER_PID_FILE, String(process.pid))

const server = http.createServer((request, response) => {
  if (request.url === '/api/login' && request.method === 'POST') {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      fs.writeFileSync(process.env.TEST_WEBRTC_LOGIN_BODY_FILE, body)
      response.setHeader('Content-Type', 'application/json')
      response.end(fs.existsSync(LOGIN_RESPONSE_FILE)
        ? fs.readFileSync(LOGIN_RESPONSE_FILE, 'utf8')
        : JSON.stringify({ token: 'fixture-token' }))
    })
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

setTimeout(() => server.listen(Number(process.env.PORT), '127.0.0.1'), 120)
process.on('SIGTERM', () => {
  server.closeAllConnections()
  server.close(() => process.exit(0))
})
`);

    const turnServerPath = join(fixtureDir, 'turnserver');
    await writeFile(turnServerPath, `#!/usr/bin/env node
const fs = require('node:fs')
const net = require('node:net')

fs.writeFileSync(process.env.TEST_WEBRTC_TURN_PID_FILE, String(process.pid))
const port = Number(process.argv[process.argv.indexOf('-p') + 1])
setTimeout(() => {
  const server = net.createServer(socket => socket.end())
  server.listen(port, '0.0.0.0')
}, 120)
process.on('SIGTERM', () => process.exit(0))
`);

    const runScript = join(agentDir, 'run.sh');
    await writeFile(runScript, `#!/bin/bash
printf 'spawn\\n' >> "$TEST_WEBRTC_AGENT_COUNT_FILE"
printf '%s' "$$" > "$TEST_WEBRTC_AGENT_PID_FILE"
if [ "$1" = "failure-address" ]; then
  exit 7
fi
if [ "$1" = "timeout-address" ]; then
  sleep 2
  exit 0
fi
sleep 0.15
printf '["%s"]' "$3" > "$TEST_WEBRTC_DEVICES_FILE"
`);

    await writeFile(fakeAdbPath, `#!/bin/bash
if [ "$1" = "devices" ]; then
  printf 'List of devices attached\\nfixture-device\\tdevice\\nsecond-address\\tdevice\\nfailure-address\\tdevice\\ntimeout-address\\tdevice\\nqueued-address\\tdevice\\n'
  exit 0
fi
if [[ "$*" == *"pkill -f cloudphone-agent"* ]]; then
  if [ -n "$TEST_WEBRTC_STOP_STARTED_FILE" ]; then
    printf started > "$TEST_WEBRTC_STOP_STARTED_FILE"
    sleep 0.1
  fi
  printf '[]' > "$TEST_WEBRTC_DEVICES_FILE"
  exit 0
fi
if [[ "$*" == *"ps -A | grep cloudphone-agent"* ]] && ! grep -q '^\\[\\]$' "$TEST_WEBRTC_DEVICES_FILE"; then
  echo cloudphone-agent
fi
`);
    await Promise.all([chmod(signalingPath, 0o755), chmod(runScript, 0o755), chmod(turnServerPath, 0o755), chmod(fakeAdbPath, 0o755)]);

    for (const key of ENV_KEYS) previousEnv.set(key, process.env[key]);
    const port = await getAvailablePort();
    turnPort = await getAvailablePort();
    Object.assign(process.env, {
      LA_PLUMA_WEBRTC_DIR: fixtureDir,
      LA_PLUMA_WEBRTC_PORT: String(port),
      LA_PLUMA_WEBRTC_TURN_PORT: String(turnPort),
      LA_PLUMA_WEBRTC_TURN_SERVER_PATH: turnServerPath,
      LA_PLUMA_WEBRTC_REQUEST_TIMEOUT_MS: '200',
      LA_PLUMA_WEBRTC_SERVER_START_TIMEOUT_MS: '3000',
      LA_PLUMA_WEBRTC_AGENT_START_TIMEOUT_MS: '1000',
      LA_PLUMA_WEBRTC_START_POLL_INTERVAL_MS: '20',
      LA_PLUMA_WEBRTC_VIEWER_IDLE_GRACE_MS: '30',
      TEST_WEBRTC_DEVICES_FILE: devicesFile,
      TEST_WEBRTC_SERVER_COUNT_FILE: serverCountFile,
      TEST_WEBRTC_SERVER_ARGS_FILE: serverArgsFile,
      TEST_WEBRTC_LOGIN_BODY_FILE: loginBodyFile,
      TEST_WEBRTC_AGENT_COUNT_FILE: agentCountFile,
      TEST_WEBRTC_AGENT_PID_FILE: agentPidFile,
      TEST_WEBRTC_SERVER_PID_FILE: serverPidFile,
      TEST_WEBRTC_TURN_PID_FILE: turnPidFile
    });
    service = await import(`../webrtcService.ts?webrtc-test=${Date.now()}`);
  });

  after(async () => {
    for (const pidFile of [serverPidFile, turnPidFile]) {
      try {
        const pid = Number(await readFile(pidFile, 'utf8'));
        if (Number.isInteger(pid)) process.kill(pid, 'SIGTERM');
      } catch {
        // The fixture process may not have started when an earlier assertion failed.
      }
    }
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it('polls readiness and returns a clear timeout for a missing device', async () => {
    let attempts = 0;
    const ready = await service.waitForWebrtcServerReady({
      timeoutMs: 200,
      pollIntervalMs: 5,
      isReachable: async () => ++attempts === 3
    });
    assert.equal(ready, true);
    assert.equal(attempts, 3);

    await assert.rejects(
      service.waitForWebrtcDevice('missing-device', {
        timeoutMs: 30,
        pollIntervalMs: 5,
        getDevices: async () => []
      }),
      error => {
        const failure = readError(error);
        return failure.code === 'WEBRTC_AGENT_START_TIMEOUT'
          && failure.message.includes('missing-device')
          && failure.message.includes('/devices');
      }
    );
  });

  it('polls the TURN port and reports startup failures', async () => {
    let attempts = 0;
    const ready = await service.waitForTurnServerReady({
      timeoutMs: 200,
      pollIntervalMs: 5,
      isListening: async () => ++attempts === 3
    });
    assert.equal(ready, true);
    assert.equal(attempts, 3);

    await assert.rejects(
      service.waitForTurnServerReady({
        timeoutMs: 20,
        pollIntervalMs: 5,
        isListening: async () => false
      }),
      error => readError(error).code === 'WEBRTC_TURN_START_TIMEOUT'
    );

    await assert.rejects(
      service.waitForTurnServerReady({
        childProcess: { exitCode: 1, signalCode: null },
        isListening: async () => false
      }),
      error => readError(error).code === 'WEBRTC_PROCESS_EXITED'
    );
  });

  it('waits for the selected ADB target and reports its actual state', async () => {
    assert.equal(service.parseAdbDeviceState(
      'List of devices attached\n127.0.0.1:5555\tdevice product:test\n',
      '127.0.0.1:5555'
    ), 'device');

    const states: Array<string | null> = [null, 'offline', 'device'];
    let attempts = 0;
    const ready = await service.waitForAdbDeviceReady('127.0.0.1:5555', fakeAdbPath, {
      timeoutMs: 1000,
      pollIntervalMs: 5,
      getDeviceState: async () => {
        attempts += 1;
        return states.length ? (states.shift() ?? null) : 'device';
      }
    });
    assert.equal(ready, 'device');
    assert.equal(attempts, 3);

    await assert.rejects(
      service.waitForAdbDeviceReady('127.0.0.1:5555', fakeAdbPath, {
        timeoutMs: 20,
        pollIntervalMs: 5,
        getDeviceState: async () => 'unauthorized'
      }),
      error => {
        const failure = readError(error);
        return failure.code === 'WEBRTC_ADB_DEVICE_UNAUTHORIZED'
          && failure.message.includes('允许调试')
          && failure.retryable === true;
      }
    );
  });

  it('recognizes a binary release layout and skips the missing source build step', async () => {
    const legacyAssetsDir = join(fixtureDir, 'assets', 'v1');
    const releaseIndex = join(fixtureDir, 'assets', 'index.html');
    const buildScript = join(fixtureDir, 'build.sh');
    const buildMarker = join(fixtureDir, 'build-ran');

    await rm(legacyAssetsDir, { recursive: true, force: true });
    await writeFile(releaseIndex, '<!doctype html>');
    await writeFile(buildScript, `#!/bin/bash\nprintf ran > "${buildMarker}"\nexit 99\n`);

    try {
      assert.equal(await service.getWebrtcAssetsPath(), join(fixtureDir, 'assets'));
      const status = await service.installWebrtc();
      assert.equal(status.installed, true);
      assert.equal(status.built, true);
      assert.equal(await service.pathExists(buildMarker), false);
    } finally {
      await Promise.all([
        rm(releaseIndex, { force: true }),
        rm(buildScript, { force: true }),
        rm(buildMarker, { force: true }),
        mkdir(legacyAssetsDir, { recursive: true })
      ]);
    }
  });

  it('serializes concurrent starts and waits for authenticated device registration', async () => {
    const [first, second] = await Promise.all([
      service.startWebrtc('fixture-device', 'preview-device', fakeAdbPath),
      service.startWebrtc('fixture-device', 'preview-device', fakeAdbPath)
    ]);

    assert.equal(first.serverRunning, true);
    assert.equal(first.agentRunning, true);
    assert.equal(first.signalingUrl, '/webrtc-signaling');
    assert.match(first.directSignalingUrl, /^ws:\/\//);
    assert.equal(second.serverRunning, true);
    assert.equal(second.agentRunning, true);
    assert.deepEqual(await service.getWebrtcDevices({ throwOnError: true }), ['preview-device']);
    assert.equal(await countLines(serverCountFile), 1);
    assert.equal(await countLines(agentCountFile), 1);
    const serverArgs = JSON.parse(await readFile(serverArgsFile, 'utf8')) as string[];
    assert.equal(serverArgs.includes('-tls=false'), true);
    assert.deepEqual(serverArgs.slice(serverArgs.indexOf('-assets'), serverArgs.indexOf('-assets') + 2), [
      '-assets',
      join(fixtureDir, 'assets', 'v1')
    ]);
    const iceIndex = serverArgs.indexOf('-ice_servers');
    assert.notEqual(iceIndex, -1);
    assert.match(serverArgs[iceIndex + 1], new RegExp(`^turn:cloudphone_user:cloudphone_secure_password@.+:${turnPort}\\?transport=udp,stun:.+:${turnPort}$`));
    assert.match(first.iceServers, new RegExp(`:${turnPort}\\?transport=udp`));

    await service.startWebrtc('fixture-device', 'preview-device', fakeAdbPath);
    assert.equal(await countLines(serverCountFile), 1);
    assert.equal(await countLines(agentCountFile), 1);

    const logPaths = await service.getWebrtcLogPaths();
    assert.deepEqual(await openFixtureLogDescriptors(Object.values(logPaths)), []);
  });

  it('logs in to the upstream with the configured signaling credentials', async () => {
    const previousUsername = process.env.LA_PLUMA_WEBRTC_USERNAME;
    const previousPassword = process.env.LA_PLUMA_WEBRTC_PASSWORD;
    try {
      process.env.LA_PLUMA_WEBRTC_USERNAME = 'fixture-console';
      process.env.LA_PLUMA_WEBRTC_PASSWORD = 'fixture-password';

      assert.equal(await service.getWebrtcAuthToken({ throwOnError: true }), 'fixture-token');
      assert.deepEqual(JSON.parse(await readFile(loginBodyFile, 'utf8')), {
        username: 'fixture-console',
        password: 'fixture-password'
      });
    } finally {
      if (previousUsername === undefined) delete process.env.LA_PLUMA_WEBRTC_USERNAME;
      else process.env.LA_PLUMA_WEBRTC_USERNAME = previousUsername;
      if (previousPassword === undefined) delete process.env.LA_PLUMA_WEBRTC_PASSWORD;
      else process.env.LA_PLUMA_WEBRTC_PASSWORD = previousPassword;
    }
  });

  it('validates the upstream login payload before using the token', async () => {
    try {
      await writeFile(loginResponseFile, JSON.stringify({ token: 123 }));
      await assert.rejects(
        service.getWebrtcAuthToken({ throwOnError: true }),
        error => readError(error).message === 'WebRTC 登录响应缺少 token'
      );
      // 非严格模式（网关默认）沿用旧约定：取不到 token 时返回空字符串。
      assert.equal(await service.getWebrtcAuthToken(), '');

      await writeFile(loginResponseFile, JSON.stringify({ access_token: 'fixture-token' }));
      await assert.rejects(
        service.getWebrtcAuthToken({ throwOnError: true }),
        error => readError(error).message === 'WebRTC 登录响应缺少 token'
      );

      await writeFile(loginResponseFile, 'not-json');
      await assert.rejects(service.getWebrtcAuthToken({ throwOnError: true }));
      assert.equal(await service.getWebrtcAuthToken(), '');
    } finally {
      await rm(loginResponseFile, { force: true });
    }
  });

  it('normalizes upstream device entries and rejects non-array device responses', async () => {
    const originalDevices = JSON.parse(await readFile(devicesFile, 'utf8')) as unknown;
    try {
      await writeFile(devicesFile, JSON.stringify([
        'string-device',
        { device_id: 'snake-id' },
        { id: 'plain-id' },
        { device_id: 7, id: 'numeric-fallback' },
        { device_id: '' },
        null,
        42,
        { device_id: 'string-device' }
      ]));
      assert.deepEqual(
        await service.getWebrtcDevices({ throwOnError: true }),
        ['string-device', 'snake-id', 'plain-id', 'numeric-fallback', 'string-device']
      );

      await writeFile(devicesFile, JSON.stringify({ devices: ['string-device'] }));
      await assert.rejects(
        service.getWebrtcDevices({ throwOnError: true }),
        error => readError(error).message === 'WebRTC /devices 响应格式无效'
      );
      // 非严格模式只返回空列表，不把格式错误当成“没有设备”。
      assert.deepEqual(await service.getWebrtcDevices(), []);
    } finally {
      await writeFile(devicesFile, JSON.stringify(originalDevices));
    }
  });

  it('does not reuse a matching device id that belongs to another address', async () => {
    const beforeSwitch = await countLines(agentCountFile);

    await service.startWebrtcAgent('second-address', 'preview-device', fakeAdbPath);
    assert.equal(await countLines(agentCountFile), beforeSwitch + 1);
    assert.deepEqual(await service.getWebrtcDevices({ throwOnError: true }), ['preview-device']);

    await service.startWebrtcAgent('second-address', 'preview-device', fakeAdbPath);
    assert.equal(await countLines(agentCountFile), beforeSwitch + 1);
  });

  it('retains direct viewers, releases the idle agent, and restores it before a new viewer connects', async () => {
    const beforeRelease = await countLines(agentCountFile);
    const first = service.registerWebrtcViewer('preview-device');
    const second = service.registerWebrtcViewer('preview-device');
    await Promise.all([first.ready, second.ready]);
    first.release();
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal((await service.getWebrtcStatus('second-address', fakeAdbPath)).agentRunning, true);

    await writeFile(devicesFile, JSON.stringify([{ device_id: 'preview-device', client_count: 1 }]));
    second.release();
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal((await service.getWebrtcStatus('second-address', fakeAdbPath)).agentRunning, true);

    await writeFile(devicesFile, JSON.stringify([{ device_id: 'preview-device', client_count: 0 }]));
    await service.waitForCondition(async () => !(await service.getWebrtcStatus('second-address', fakeAdbPath)).agentRunning, {
      timeoutMs: 1000,
      pollIntervalMs: 10,
      timeoutMessage: 'idle agent did not stop'
    });
    assert.equal(await service.isWebrtcServerReachable(), true);
    assert.equal(await countLines(agentCountFile), beforeRelease);

    const resumed = service.registerWebrtcViewer('preview-device');
    await resumed.ready;
    assert.equal((await service.getWebrtcStatus('second-address', fakeAdbPath)).agentRunning, true);
    assert.equal(await countLines(agentCountFile), beforeRelease + 1);

    const stopStartedFile = join(fixtureDir, 'idle-stop-started');
    process.env.TEST_WEBRTC_STOP_STARTED_FILE = stopStartedFile;
    try {
      resumed.release();
      await service.waitForCondition(() => service.pathExists(stopStartedFile), {
        timeoutMs: 1000,
        pollIntervalMs: 5,
        timeoutMessage: 'idle stop did not begin'
      });
      const racingViewer = service.registerWebrtcViewer('preview-device');
      await racingViewer.ready;
      assert.equal((await service.getWebrtcStatus('second-address', fakeAdbPath)).agentRunning, true);
      assert.equal(await countLines(agentCountFile), beforeRelease + 2);
      racingViewer.release();
    } finally {
      delete process.env.TEST_WEBRTC_STOP_STARTED_FILE;
    }
  });

  it('rejects a nonzero agent deployment and cleans up the target address', async () => {
    const beforeFailure = await countLines(agentCountFile);

    await assert.rejects(
      service.startWebrtcAgent('failure-address', 'failed-device', fakeAdbPath),
      error => {
        const failure = readError(error);
        return failure.code === 'WEBRTC_PROCESS_EXITED' && failure.message.includes('退出码 7');
      }
    );

    assert.equal(await countLines(agentCountFile), beforeFailure + 1);
    assert.deepEqual(JSON.parse(await readFile(devicesFile, 'utf8')), []);
  });

  it('terminates and cleans up an agent deployment that times out', async () => {
    const beforeTimeout = await countLines(agentCountFile);

    await assert.rejects(
      service.startWebrtcAgent('timeout-address', 'timeout-device', fakeAdbPath),
      error => {
        const failure = readError(error);
        return failure.code === 'WEBRTC_AGENT_START_TIMEOUT' && failure.message.includes('timeout-device');
      }
    );

    assert.equal(await countLines(agentCountFile), beforeTimeout + 1);
    assert.deepEqual(JSON.parse(await readFile(devicesFile, 'utf8')), []);
    assert.equal((await service.getWebrtcStatus('timeout-address', fakeAdbPath)).agentRunning, false);
    const deploymentPid = Number(await readFile(agentPidFile, 'utf8'));
    await service.waitForCondition(() => {
      try {
        process.kill(deploymentPid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    }, {
      timeoutMs: 200,
      pollIntervalMs: 10,
      timeoutMessage: 'timed-out agent deployment was not terminated'
    });
  });

  it('serializes start, start, and stop so no queued start resurrects the preview', async () => {
    const beforeInterleaving = await countLines(agentCountFile);
    const results = await Promise.all([
      service.startWebrtc('queued-address', 'queued-device', fakeAdbPath),
      service.startWebrtc('queued-address', 'queued-device', fakeAdbPath),
      service.stopWebrtc('queued-address', fakeAdbPath)
    ]);
    const first = results[0] as WebrtcRunningStatus;
    const second = results[1] as WebrtcRunningStatus;
    const stopped = results[2] as WebrtcStopSummary;

    assert.equal(first.agentRunning, true);
    assert.equal(second.agentRunning, true);
    assert.equal(stopped.stopped, true);
    assert.deepEqual([...stopped.released].sort(), ['device-agent', 'server', 'turn']);
    assert.equal(await countLines(agentCountFile), beforeInterleaving + 1);
    assert.deepEqual(JSON.parse(await readFile(devicesFile, 'utf8')), []);

    await service.waitForCondition(async () => !await service.isWebrtcServerReachable(), {
      timeoutMs: 500,
      pollIntervalMs: 10,
      timeoutMessage: 'fixture signaling server did not stop'
    });
    assert.equal(await countLines(serverCountFile), 1);
  });
});
