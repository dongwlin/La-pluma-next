import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, it } from 'node:test';
import { createWebrtcViewerLifecycle } from '../webrtcService.ts';
import type { WebrtcViewerLifecycle, WebrtcViewerLifecycleOptions } from '../webrtcService.ts';

const registries: WebrtcViewerLifecycle[] = [];
const IDLE_GRACE_MS = 15;

interface ReleasedIdle {
  deviceId: string;
  generation: number;
}

function createFixture(options: WebrtcViewerLifecycleOptions = {}): {
  lifecycle: WebrtcViewerLifecycle;
  released: ReleasedIdle[];
  restored: string[];
} {
  const released: ReleasedIdle[] = [];
  const restored: string[] = [];
  const lifecycle = createWebrtcViewerLifecycle({
    idleGraceMs: IDLE_GRACE_MS,
    startupGraceMs: 40,
    releaseIdle: (deviceId, generation, isIdle) => {
      if (isIdle()) released.push({ deviceId, generation });
    },
    restore: async deviceId => { restored.push(deviceId); },
    ...options
  });
  registries.push(lifecycle);
  return { lifecycle, released, restored };
}

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'viewer lifecycle did not settle');
    await delay(5);
  }
}

/** 通过参数传入，避免控制流把被闭包重新赋值的变量窄化成 null。 */
function invokeQueuedCleanup(cleanup: (() => void) | null | undefined): void {
  cleanup?.();
}

afterEach(() => {
  while (registries.length) registries.pop()?.close();
});

describe('WebRTC viewer lifecycle', () => {
  it('releases only the device whose last browser has left', async () => {
    const { lifecycle, released } = createFixture();
    lifecycle.started('first-device', 1);
    lifecycle.started('second-device', 2);
    const firstTab = lifecycle.retain('first-device');
    const secondTab = lifecycle.retain('first-device');
    const otherDevice = lifecycle.retain('second-device');
    await Promise.all([firstTab.ready, secondTab.ready, otherDevice.ready]);

    firstTab.release();
    await delay(IDLE_GRACE_MS * 2);
    assert.deepEqual(released, []);

    secondTab.release();
    secondTab.release();
    await waitUntil(() => released.length === 1);
    assert.deepEqual(released, [{ deviceId: 'first-device', generation: 1 }]);
  });

  it('keeps the agent through navigation and invalidates queued cleanup after a new start', async () => {
    let runQueuedCleanup: (() => void) | null | undefined;
    const released: ReleasedIdle[] = [];
    const { lifecycle } = createFixture({
      releaseIdle: (deviceId, generation, isIdle) => new Promise<void>(resolve => {
        runQueuedCleanup = () => {
          if (isIdle()) released.push({ deviceId, generation });
          resolve();
        };
      })
    });
    lifecycle.started('preview-device', 1);
    const oldTab = lifecycle.retain('preview-device');
    oldTab.release();
    const nextPage = lifecycle.retain('preview-device');
    await delay(IDLE_GRACE_MS * 2);
    assert.equal(Boolean(runQueuedCleanup), false);

    nextPage.release();
    await waitUntil(() => Boolean(runQueuedCleanup));
    const newTab = lifecycle.retain('preview-device');
    invokeQueuedCleanup(runQueuedCleanup);
    await newTab.ready;
    assert.deepEqual(released, []);

    newTab.release();
    runQueuedCleanup = null;
    await waitUntil(() => Boolean(runQueuedCleanup));
    lifecycle.started('preview-device', 2);
    invokeQueuedCleanup(runQueuedCleanup);
    assert.deepEqual(released, []);
  });

  it('cleans a completed start that never acquired a viewer', async () => {
    const { lifecycle, released } = createFixture();
    lifecycle.started('canceled-preview', 5);
    await delay(IDLE_GRACE_MS);
    assert.deepEqual(released, []);
    await waitUntil(() => released.length === 1);
    assert.deepEqual(released, [{ deviceId: 'canceled-preview', generation: 5 }]);
  });

  it('conservatively retains agents while a legacy unscoped gateway client is connected', async () => {
    const { lifecycle, released } = createFixture();
    lifecycle.started('preview-device', 1);
    const legacy = lifecycle.retain(null);
    const viewer = lifecycle.retain('preview-device');
    viewer.release();
    await delay(60);
    assert.deepEqual(released, []);

    legacy.release();
    await waitUntil(() => released.length === 1);
    assert.deepEqual(released, [{ deviceId: 'preview-device', generation: 1 }]);
  });

  it('reschedules the idle release while the owner still reports an active viewer', async () => {
    let attempts = 0;
    const { lifecycle, released } = createFixture({
      releaseIdle: (deviceId, generation, isIdle) => {
        attempts += 1;
        // 上游仍报告观看者时返回 retry；未知形状按不重试处理。
        if (attempts === 1) return { retry: true };
        if (isIdle()) released.push({ deviceId, generation });
        return { stopped: true };
      }
    });
    lifecycle.started('busy-device', 7);
    await waitUntil(() => attempts >= 2);
    assert.deepEqual(released, [{ deviceId: 'busy-device', generation: 7 }]);
  });
});
