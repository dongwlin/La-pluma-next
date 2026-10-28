import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { getWebrtcHostIp, getWebrtcRuntimeBinary } from '../webrtcRuntime.ts';

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
