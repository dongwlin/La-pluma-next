import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, it } from 'node:test'
import { createWebrtcViewerLifecycle } from '../webrtcService.js'

const registries = []
const IDLE_GRACE_MS = 15

function createFixture(options = {}) {
  const released = []
  const restored = []
  const lifecycle = createWebrtcViewerLifecycle({
    idleGraceMs: IDLE_GRACE_MS,
    startupGraceMs: 40,
    releaseIdle: (deviceId, generation, isIdle) => {
      if (isIdle()) released.push({ deviceId, generation })
    },
    restore: async deviceId => { restored.push(deviceId) },
    ...options
  })
  registries.push(lifecycle)
  return { lifecycle, released, restored }
}

async function waitUntil(check) {
  const deadline = Date.now() + 1000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'viewer lifecycle did not settle')
    await delay(5)
  }
}

afterEach(() => {
  while (registries.length) registries.pop().close()
})

describe('WebRTC viewer lifecycle', () => {
  it('releases only the device whose last browser has left', async () => {
    const { lifecycle, released } = createFixture()
    lifecycle.started('first-device', 1)
    lifecycle.started('second-device', 2)
    const firstTab = lifecycle.retain('first-device')
    const secondTab = lifecycle.retain('first-device')
    const otherDevice = lifecycle.retain('second-device')
    await Promise.all([firstTab.ready, secondTab.ready, otherDevice.ready])

    firstTab.release()
    await delay(IDLE_GRACE_MS * 2)
    assert.deepEqual(released, [])

    secondTab.release()
    secondTab.release()
    await waitUntil(() => released.length === 1)
    assert.deepEqual(released, [{ deviceId: 'first-device', generation: 1 }])
  })

  it('keeps the agent through navigation and invalidates queued cleanup after a new start', async () => {
    let runQueuedCleanup
    const released = []
    const { lifecycle } = createFixture({
      releaseIdle: (deviceId, generation, isIdle) => new Promise(resolve => {
        runQueuedCleanup = () => {
          if (isIdle()) released.push({ deviceId, generation })
          resolve()
        }
      })
    })
    lifecycle.started('preview-device', 1)
    const oldTab = lifecycle.retain('preview-device')
    oldTab.release()
    const nextPage = lifecycle.retain('preview-device')
    await delay(IDLE_GRACE_MS * 2)
    assert.equal(runQueuedCleanup, undefined)

    nextPage.release()
    await waitUntil(() => Boolean(runQueuedCleanup))
    const newTab = lifecycle.retain('preview-device')
    runQueuedCleanup()
    await newTab.ready
    assert.deepEqual(released, [])

    newTab.release()
    runQueuedCleanup = null
    await waitUntil(() => Boolean(runQueuedCleanup))
    lifecycle.started('preview-device', 2)
    runQueuedCleanup()
    assert.deepEqual(released, [])
  })

  it('cleans a completed start that never acquired a viewer', async () => {
    const { lifecycle, released } = createFixture()
    lifecycle.started('canceled-preview', 5)
    await delay(IDLE_GRACE_MS)
    assert.deepEqual(released, [])
    await waitUntil(() => released.length === 1)
    assert.deepEqual(released, [{ deviceId: 'canceled-preview', generation: 5 }])
  })

  it('conservatively retains agents while a legacy unscoped gateway client is connected', async () => {
    const { lifecycle, released } = createFixture()
    lifecycle.started('preview-device', 1)
    const legacy = lifecycle.retain(null)
    const viewer = lifecycle.retain('preview-device')
    viewer.release()
    await delay(60)
    assert.deepEqual(released, [])

    legacy.release()
    await waitUntil(() => released.length === 1)
    assert.deepEqual(released, [{ deviceId: 'preview-device', generation: 1 }])
  })
})
