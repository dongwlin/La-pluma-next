import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import router from '../agent.js';
import { buildWebrtcBrowserProtocol } from '../agentPreviewRoutes.js';

// 预览入口由独立子 router 承担：按 agent.js 的实际挂载关系递归解析，
// 证明截图、WebRTC、方向与设备采样仍通过聚合 router 暴露，而不是只
// 存在于某个文件里。
function collectMountedRoutes(routerInstance, routes = []) {
  for (const layer of routerInstance.stack) {
    if (layer.route) {
      for (const [method, enabled] of Object.entries(layer.route.methods ?? {})) {
        if (enabled) routes.push(`${method.toUpperCase()} ${layer.route.path}`);
      }
      continue;
    }
    if (layer.handle?.stack) collectMountedRoutes(layer.handle, routes);
  }
  return routes;
}

describe('preview route exposure', () => {
  it('mounts every preview entry exactly once through the agent router', () => {
    const expected = [
      'POST /screen/screenshot',
      'GET /webrtc/status',
      'GET /webrtc/devices',
      'POST /webrtc/start',
      'POST /webrtc/stop',
      'POST /preview/orientation',
      'POST /webrtc/install',
      'POST /webrtc/start-server',
      'POST /webrtc/stop-server',
      'POST /webrtc/start-agent',
      'POST /webrtc/stop-agent',
      'GET /device-stats'
    ];
    const mounted = collectMountedRoutes(router);

    for (const route of expected) {
      assert.equal(
        mounted.filter(candidate => candidate === route).length,
        1,
        `expected exactly one mounted ${route}`
      );
    }
  });

  it('documents the same-origin browser signaling endpoint', () => {
    assert.deepEqual(buildWebrtcBrowserProtocol('preview-device'), {
      websocket: '/webrtc-signaling/connect_client?token=',
      connectMessage: { message_type: 'connect', device_id: 'preview-device' },
      requestOfferPayload: { type: 'request-offer', ip_preference: 'ipv4' },
      candidatePolicy: 'relay preferred / ipv4'
    });
  });
});
