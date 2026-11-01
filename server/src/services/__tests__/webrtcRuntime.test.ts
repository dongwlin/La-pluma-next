import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  applyWebrtcReleaseLayout,
  getWebrtcHostIp,
  getWebrtcRuntimeBinary,
  readWebrtcRuntimeVersion,
  resolveWebrtcInstallAction,
  WEBRTC_RUNTIME_MARKER_FILENAME,
  writeWebrtcRuntimeMarker
} from '../webrtcRuntime.ts';

describe('WebRTC runtime platform and network selection', () => {
  it('selects a native release binary and rejects unsupported architectures', () => {
    assert.equal(getWebrtcRuntimeBinary('/runtime', 'linux', 'x64'), join('/runtime', 'bin/linux_amd64/webrtc-signaling'));
    assert.equal(getWebrtcRuntimeBinary('/runtime', 'linux', 'arm64'), join('/runtime', 'bin/linux_arm64/webrtc-signaling'));
    assert.equal(getWebrtcRuntimeBinary('/runtime', 'darwin', 'x64'), join('/runtime', 'bin/darwin_amd64/webrtc-signaling'));

    assert.throws(() => getWebrtcRuntimeBinary('/runtime', 'linux', 'ia32'), { code: 'WEBRTC_UNSUPPORTED_PLATFORM' });
    // win32 没有上游发布包，同样在取得路径前失败，不猜测兼容目录。
    assert.throws(() => getWebrtcRuntimeBinary('/runtime', 'win32', 'x64'), { code: 'WEBRTC_UNSUPPORTED_PLATFORM' });
  });

  it('advertises the device subnet interface instead of a loopback or unrelated Docker bridge', () => {
    const previous = process.env.LA_PLUMA_WEBRTC_HOST_IP;
    delete process.env.LA_PLUMA_WEBRTC_HOST_IP;
    try {
      const interfaces = {
        lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
        docker0: [{ address: '172.17.0.1', netmask: '255.255.0.0', family: 'IPv4', internal: false }],
        enp1s0: [{ address: '192.168.1.10', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
        waydroid0: [{ address: '192.168.240.1', netmask: '255.255.255.0', family: 'IPv4', internal: false }]
      };
      assert.equal(getWebrtcHostIp('192.168.240.112:5555', interfaces), '192.168.240.1');
      assert.equal(getWebrtcHostIp('usb-device', interfaces), '192.168.1.10');
      process.env.LA_PLUMA_WEBRTC_HOST_IP = '10.0.0.5';
      assert.equal(getWebrtcHostIp('192.168.240.112:5555', interfaces), '10.0.0.5');
      // 显式覆盖必须是 IPv4；其它格式属于配置错误，不回退到自动选择。
      process.env.LA_PLUMA_WEBRTC_HOST_IP = '2001:db8::5';
      assert.throws(
        () => getWebrtcHostIp('192.168.240.112:5555', interfaces),
        error => (error as { message?: string }).message === 'LA_PLUMA_WEBRTC_HOST_IP 必须是宿主机的 IPv4 地址'
      );
    } finally {
      if (previous === undefined) delete process.env.LA_PLUMA_WEBRTC_HOST_IP;
      else process.env.LA_PLUMA_WEBRTC_HOST_IP = previous;
    }
  });
});

describe('WebRTC runtime version marker', () => {
  it('round-trips the marker and treats missing or corrupt files as unknown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'la-pluma-webrtc-marker-'));
    try {
      assert.equal(await readWebrtcRuntimeVersion(dir), null);
      await writeWebrtcRuntimeMarker(dir, 'v0.4.3');
      assert.equal(await readWebrtcRuntimeVersion(dir), 'v0.4.3');
      await writeFile(join(dir, WEBRTC_RUNTIME_MARKER_FILENAME), '{not json');
      assert.equal(await readWebrtcRuntimeVersion(dir), null);
      await writeFile(join(dir, WEBRTC_RUNTIME_MARKER_FILENAME), '{"version":42}');
      assert.equal(await readWebrtcRuntimeVersion(dir), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('WebRTC install decision', () => {
  const installed = {
    binaryPresent: true,
    assetsPresent: true,
    runScriptPresent: true,
    buildScriptPresent: false,
    markerVersion: 'v0.4.3',
    targetVersion: 'v0.4.3'
  };

  it('skips only when the installed marker matches the pinned release', () => {
    assert.equal(resolveWebrtcInstallAction(installed), 'skip');
    // 版本标记缺失（旧版本安装）或不一致都按升级处理。
    assert.equal(resolveWebrtcInstallAction({ ...installed, markerVersion: null }), 'upgrade');
    assert.equal(resolveWebrtcInstallAction({ ...installed, markerVersion: 'v0.4.1' }), 'upgrade');
  });

  it('keeps source checkouts away from release downloads', () => {
    const checkout = { ...installed, buildScriptPresent: true, markerVersion: null };
    assert.equal(resolveWebrtcInstallAction(checkout), 'skip');
    assert.equal(resolveWebrtcInstallAction({ ...checkout, binaryPresent: false }), 'build');
    assert.equal(resolveWebrtcInstallAction({ ...checkout, runScriptPresent: false }), 'build');
  });

  it('installs the release when runtime resources are missing', () => {
    assert.equal(resolveWebrtcInstallAction({ ...installed, binaryPresent: false }), 'release');
    assert.equal(resolveWebrtcInstallAction({ ...installed, assetsPresent: false }), 'release');
    assert.equal(resolveWebrtcInstallAction({ ...installed, runScriptPresent: false }), 'release');
  });
});

describe('WebRTC release layout apply', () => {
  const STAGING_BIN_DIRS = ['bin/linux_amd64', 'bin/linux_arm64', 'bin/darwin_amd64', 'bin/darwin_arm64'];

  async function createStaging(): Promise<string> {
    const staging = await mkdtemp(join(tmpdir(), 'la-pluma-webrtc-stage-'));
    for (const relativeDir of STAGING_BIN_DIRS) {
      await mkdir(join(staging, relativeDir), { recursive: true });
      await writeFile(join(staging, relativeDir, 'webrtc-signaling'), '#!/bin/sh\necho staging\n');
    }
    await mkdir(join(staging, 'assets'), { recursive: true });
    await writeFile(join(staging, 'assets', 'index.html'), '<!doctype html>');
    await mkdir(join(staging, 'agentd'), { recursive: true });
    await writeFile(join(staging, 'agentd', 'run.sh'), '#!/bin/bash\necho staging\n');
    return staging;
  }

  it('keeps existing files on a fresh install and does not touch the marker', async () => {
    const staging = await createStaging();
    const target = await mkdtemp(join(tmpdir(), 'la-pluma-webrtc-target-'));
    try {
      await mkdir(join(target, 'agentd'), { recursive: true });
      await writeFile(join(target, 'agentd', 'run.sh'), '#!/bin/bash\necho existing\n');

      await applyWebrtcReleaseLayout(staging, target);

      assert.equal(await readFile(join(target, 'agentd', 'run.sh'), 'utf8'), '#!/bin/bash\necho existing\n');
      assert.equal(await readFile(join(target, 'assets', 'index.html'), 'utf8'), '<!doctype html>');
      // 版本标记由 installWebrtcRelease 负责写，落位缝隙不越权。
      assert.equal(await readWebrtcRuntimeVersion(target), null);
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

  it('overwrites runtime files, backs up run.sh and preserves sibling data on upgrade', async () => {
    const staging = await createStaging();
    const target = await mkdtemp(join(tmpdir(), 'la-pluma-webrtc-target-'));
    try {
      await mkdir(join(target, 'agentd'), { recursive: true });
      await mkdir(join(target, 'la-pluma-webrtc-server'), { recursive: true });
      await writeFile(join(target, 'agentd', 'run.sh'), '#!/bin/bash\necho existing\n');
      await writeFile(join(target, 'la-pluma-webrtc-server', 'turn.log'), 'keep');

      await applyWebrtcReleaseLayout(staging, target, { overwrite: true, previousVersion: 'v0.4.1' });

      assert.equal(await readFile(join(target, 'agentd', 'run.sh'), 'utf8'), '#!/bin/bash\necho staging\n');
      assert.equal(
        await readFile(join(target, 'agentd', 'run.sh.before-upgrade-v0.4.1'), 'utf8'),
        '#!/bin/bash\necho existing\n'
      );
      // 运行数据目录不在复制清单内，升级不清理。
      assert.equal(await readFile(join(target, 'la-pluma-webrtc-server', 'turn.log'), 'utf8'), 'keep');
      const relativeBinary = getWebrtcRuntimeBinary(target).slice(target.length + 1);
      assert.equal((await stat(join(target, relativeBinary))).mode & 0o777, 0o755);
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

  it('names the run.sh backup for unknown previous versions', async () => {
    const staging = await createStaging();
    const target = await mkdtemp(join(tmpdir(), 'la-pluma-webrtc-target-'));
    try {
      await mkdir(join(target, 'agentd'), { recursive: true });
      await writeFile(join(target, 'agentd', 'run.sh'), '#!/bin/bash\necho existing\n');

      await applyWebrtcReleaseLayout(staging, target, { overwrite: true });

      assert.equal(await readFile(join(target, 'agentd', 'run.sh.before-upgrade-unknown'), 'utf8'), '#!/bin/bash\necho existing\n');
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });
});
