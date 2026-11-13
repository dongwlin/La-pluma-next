// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTouchInput } from './touchInput'

interface TouchPacket {
  type: string
  action: number
  id: number
  seq: number
  client_ts_ms: number
  x: number
  y: number
  w: number
  h: number
}

function createChannel() {
  const channel = {
    readyState: 'open' as RTCDataChannelState,
    bufferedAmount: 0,
    send: vi.fn<(data: string) => void>(),
  }
  return {
    channel,
    packets: () => channel.send.mock.calls.map(([payload]) => JSON.parse(payload) as TouchPacket),
  }
}

function createVideo(width = 640, height = 360, rect = new DOMRect(100, 50, 640, 360)) {
  const video = document.createElement('video')
  Object.defineProperties(video, {
    videoWidth: { configurable: true, get: () => width },
    videoHeight: { configurable: true, get: () => height },
  })
  vi.spyOn(video, 'getBoundingClientRect').mockImplementation(() => rect)
  return {
    video,
    setRect: (next: DOMRect) => { rect = next },
    setFrame: (nextWidth: number, nextHeight: number) => { width = nextWidth; height = nextHeight },
  }
}

function createReadyInput() {
  const input = createTouchInput()
  const connection = createChannel()
  input.setChannel(connection.channel)
  input.setDeviceSize(1280, 720)
  return { input, ...connection }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('touch coordinate space', () => {
  it.each([
    { device: [1920, 1080], frame: [640, 360], target: [1920, 1080] },
    { device: [1920, 1080], frame: [360, 640], target: [1080, 1920] },
    { device: [1080, 1920], frame: [640, 360], target: [1920, 1080] },
    { device: [1080, 1920], frame: [360, 640], target: [1080, 1920] },
  ])('maps native $device and video $frame into $target', ({ device, frame, target }) => {
    const { input, packets } = createReadyInput()
    const [deviceW, deviceH] = device
    const [frameW, frameH] = frame
    const [targetW, targetH] = target
    input.setDeviceSize(deviceW, deviceH)
    const { video } = createVideo(frameW, frameH, new DOMRect(100, 50, frameW, frameH))

    expect(input.sendTouch(0, 100 + frameW! * 0.75, 50 + frameH! * 0.25, 7, video)).toBe(true)
    expect(packets()).toEqual([expect.objectContaining({
      type: 'touch', action: 0, id: 7, x: targetW! * 0.75, y: targetH! * 0.25, w: targetW, h: targetH,
    })])
  })

  it.each([
    { frameW: 640, frameH: 360, x: 580, y: 430, outsideX: 200, outsideY: 220, targetW: 1280, targetH: 720, expectedX: 960, expectedY: 180 },
    { frameW: 360, frameH: 640, x: 510, y: 360, outsideX: 120, outsideY: 300, targetW: 720, targetH: 1280, expectedX: 540, expectedY: 320 },
  ])('excludes contain bars and subtracts page offsets for $frameW x $frameH', testCase => {
    const { input, packets } = createReadyInput()
    const { video } = createVideo(testCase.frameW, testCase.frameH, new DOMRect(100, 200, 640, 640))

    expect(input.sendTouch(0, testCase.outsideX, testCase.outsideY, 1, video)).toBe(false)
    expect(packets()).toEqual([])
    expect(input.sendTouch(0, testCase.x, testCase.y, 1, video)).toBe(true)
    expect(packets()[0]).toMatchObject({ x: testCase.expectedX, y: testCase.expectedY, w: testCase.targetW, h: testCase.targetH })
  })

  it('uses the current element rectangle after scroll or layout resize', () => {
    const { input, packets } = createReadyInput()
    const { video, setRect } = createVideo()
    expect(input.sendTouch(0, 420, 230, 1, video)).toBe(true)

    setRect(new DOMRect(300, 200, 320, 180))
    expect(input.sendTouch(2, 540, 245, 1, video)).toBe(true)
    expect(packets().map(({ action, x, y }) => ({ action, x, y }))).toEqual([
      { action: 0, x: 640, y: 360 },
      { action: 2, x: 960, y: 180 },
    ])
  })

  it('clamps captured moves and inclusive content edges to valid device pixels', () => {
    const { input, packets } = createReadyInput()
    const { video } = createVideo()
    expect(input.sendTouch(0, 740, 410, 1, video)).toBe(true)
    expect(input.sendTouch(2, -10, 900, 1, video)).toBe(true)
    expect(input.sendTouch(1, 900, -10, 1, video)).toBe(true)
    expect(packets().map(({ action, x, y }) => ({ action, x, y }))).toEqual([
      { action: 0, x: 1279, y: 719 },
      { action: 2, x: 0, y: 719 },
      { action: 1, x: 1279, y: 0 },
    ])
  })

  it('does not multiply CSS coordinates by the device pixel ratio', () => {
    vi.stubGlobal('devicePixelRatio', 3)
    const { input, packets } = createReadyInput()
    const { video } = createVideo()
    expect(input.sendTouch(0, 580, 140, 1, video)).toBe(true)
    expect(packets()[0]).toMatchObject({ x: 960, y: 180, w: 1280, h: 720 })
  })

  it.each([
    { label: 'missing media', video: null, x: 420, y: 230 },
    { label: 'nonfinite position', video: createVideo, x: NaN, y: 230 },
  ])('rejects a new gesture with $label', ({ video: makeVideo, x, y }) => {
    const { input, packets } = createReadyInput()
    expect(input.sendTouch(0, x, y, 1, makeVideo?.().video ?? null)).toBe(false)
    expect(packets()).toEqual([])
  })

  it('requires valid media dimensions and a nonempty layout for a new gesture', () => {
    const { input, packets } = createReadyInput()
    const { video, setFrame, setRect } = createVideo(0, 0)
    expect(input.sendTouch(0, 420, 230, 1, video)).toBe(false)
    setFrame(640, 360)
    setRect(new DOMRect(100, 50, 0, 0))
    expect(input.sendTouch(0, 420, 230, 1, video)).toBe(false)
    expect(packets()).toEqual([])
  })
})

describe('gesture lifetime', () => {
  it('finishes on its original video even when the current surface is absent or replaced', () => {
    const { input, packets } = createReadyInput()
    const { video } = createVideo()
    const replacement = createVideo(360, 640, new DOMRect(0, 0, 360, 640))
    expect(input.sendTouch(0, 420, 230, 1, video)).toBe(true)
    expect(input.sendTouch(2, 580, 140, 1, replacement.video)).toBe(true)
    expect(input.sendTouch(1, 580, 140, 1, null)).toBe(true)
    expect(packets().slice(1)).toEqual([
      expect.objectContaining({ action: 2, x: 960, y: 180, w: 1280, h: 720 }),
      expect.objectContaining({ action: 1, x: 960, y: 180, w: 1280, h: 720 }),
    ])
  })

  it.each([1, 3])('releases with action %i and last valid coordinates after layout teardown', action => {
    const { input, packets } = createReadyInput()
    const { video, setRect } = createVideo()
    expect(input.sendTouch(0, 580, 140, 5, video)).toBe(true)
    setRect(new DOMRect())
    expect(input.sendTouch(action, NaN, NaN, 5, null)).toBe(true)
    expect(packets()[1]).toMatchObject({ action, id: 5, x: 960, y: 180, w: 1280, h: 720 })
    expect(input.sendTouch(1, 580, 140, 5, video)).toBe(false)
    expect(packets()).toHaveLength(2)
  })

  it('rejects orphan moves, releases, cancellations and unsupported actions', () => {
    const { input, packets } = createReadyInput()
    const { video } = createVideo()
    for (const action of [1, 2, 3, -1, 4]) expect(input.sendTouch(action, 420, 230, 1, video)).toBe(false)
    expect(packets()).toEqual([])
  })

  it('keeps two pointers independent through interleaved moves and releases', () => {
    const { input, packets } = createReadyInput()
    const { video } = createVideo()
    expect(input.sendTouch(0, 260, 140, 10, video)).toBe(true)
    expect(input.sendTouch(0, 580, 320, 20, video)).toBe(true)
    expect(input.sendTouch(2, 420, 230, 10, video)).toBe(true)
    expect(input.sendTouch(1, NaN, NaN, 20, null)).toBe(true)
    expect(input.sendTouch(1, NaN, NaN, 10, null)).toBe(true)
    expect(packets().slice(-2)).toEqual([
      expect.objectContaining({ action: 1, id: 20, x: 960, y: 540 }),
      expect.objectContaining({ action: 1, id: 10, x: 640, y: 360 }),
    ])
    expect(packets().map(packet => packet.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('cancels a previous press before reusing its pointer id', () => {
    const { input, packets } = createReadyInput()
    const { video } = createVideo()
    input.sendTouch(0, 260, 140, 1, video)
    expect(input.sendTouch(0, 580, 320, 1, video)).toBe(true)
    expect(packets()).toEqual([
      expect.objectContaining({ action: 0, id: 1, x: 320, y: 180 }),
      expect.objectContaining({ action: 3, id: 1, x: 320, y: 180 }),
      expect.objectContaining({ action: 0, id: 1, x: 960, y: 540 }),
    ])
  })

  it.each([
    { width: 360, height: 640, reason: 'rotation' },
    { width: 1280, height: 720, reason: 'frame resolution change' },
  ])('cancels all pointers in their old space on $reason', ({ width, height }) => {
    const { input, packets } = createReadyInput()
    const { video, setFrame } = createVideo()
    input.sendTouch(0, 260, 140, 1, video)
    input.sendTouch(0, 580, 320, 2, video)
    setFrame(width, height)
    video.dispatchEvent(new Event('resize'))
    expect(packets().slice(2)).toEqual([
      expect.objectContaining({ action: 3, id: 1, x: 320, y: 180, w: 1280, h: 720 }),
      expect.objectContaining({ action: 3, id: 2, x: 960, y: 540, w: 1280, h: 720 }),
    ])
    expect(input.sendTouch(1, 420, 230, 1, video)).toBe(false)
    expect(input.sendTouch(2, 420, 230, 2, video)).toBe(false)
  })

  it('also cancels on a changed frame before its resize event arrives', () => {
    const { input, packets } = createReadyInput()
    const { video, setFrame } = createVideo()
    input.sendTouch(0, 420, 230, 1, video)
    setFrame(360, 640)
    expect(input.sendTouch(1, 420, 230, 1, video)).toBe(false)
    expect(packets()[1]).toMatchObject({ action: 3, x: 640, y: 360, w: 1280, h: 720 })
    expect(input.sendTouch(0, 420, 230, 1, video)).toBe(true)
    expect(packets()[2]).toMatchObject({ action: 0, w: 720, h: 1280 })
  })
})

describe('device metadata and connection boundaries', () => {
  it('waits for device metadata before accepting the first press', () => {
    const input = createTouchInput()
    const { channel, packets } = createChannel()
    const { video } = createVideo()
    input.setChannel(channel)
    expect(input.sendTouch(0, 420, 230, 1, video)).toBe(false)
    expect(packets()).toEqual([])
    expect(input.setDeviceSize(1280, 720)).toBe(true)
    expect(input.sendTouch(0, 420, 230, 1, video)).toBe(true)
  })

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1280', null, undefined])(
    'invalidates device size when a dimension is %s', dimension => {
      const { input, packets } = createReadyInput()
      const { video } = createVideo()
      expect(input.setDeviceSize(dimension, 720)).toBe(false)
      expect(input.sendTouch(0, 420, 230, 1, video)).toBe(false)
      expect(input.setDeviceSize(1280, dimension)).toBe(false)
      expect(input.sendTouch(0, 420, 230, 1, video)).toBe(false)
      expect(packets()).toEqual([])
    },
  )

  it('preserves an active gesture when valid metadata is repeated', () => {
    const { input, packets } = createReadyInput()
    const { video } = createVideo()
    input.sendTouch(0, 420, 230, 1, video)
    input.setDeviceSize(1280, 720)
    expect(input.sendTouch(1, 420, 230, 1, video)).toBe(true)
    expect(packets().map(packet => packet.action)).toEqual([0, 1])
  })

  it.each([
    { width: 800, height: 1280 },
    { width: undefined, height: undefined },
  ])('cancels old gestures when device size becomes $width x $height', ({ width, height }) => {
    const { input, packets } = createReadyInput()
    const { video } = createVideo()
    input.sendTouch(0, 580, 140, 1, video)
    input.setDeviceSize(width, height)
    expect(packets()[1]).toMatchObject({ action: 3, x: 960, y: 180, w: 1280, h: 720 })
    expect(input.sendTouch(1, 580, 140, 1, video)).toBe(false)
  })

  it('cancels on the old channel before accepting input on its replacement', () => {
    const { input, packets } = createReadyInput()
    const replacement = createChannel()
    const { video } = createVideo()
    input.sendTouch(0, 420, 230, 1, video)
    input.setChannel(replacement.channel)
    expect(packets().map(packet => packet.action)).toEqual([0, 3])
    expect(replacement.packets()).toEqual([])
    expect(input.sendTouch(1, 420, 230, 1, video)).toBe(false)
    expect(input.sendTouch(0, 420, 230, 1, video)).toBe(true)
    expect(replacement.packets()[0]).toMatchObject({ action: 0, w: 1280, h: 720 })
  })

  it('does not cancel when the channel object is unchanged', () => {
    const { input, channel, packets } = createReadyInput()
    const { video } = createVideo()
    input.sendTouch(0, 420, 230, 1, video)
    input.setChannel(channel)
    expect(input.sendTouch(1, 420, 230, 1, video)).toBe(true)
    expect(packets().map(packet => packet.action)).toEqual([0, 1])
  })

  it('resets all pointers and requires fresh metadata after reconnect', () => {
    const { input, channel, packets } = createReadyInput()
    const { video, setFrame } = createVideo()
    input.sendTouch(0, 260, 140, 1, video)
    input.sendTouch(0, 580, 320, 2, video)
    input.reset()
    input.reset()
    expect(packets().map(packet => packet.action)).toEqual([0, 0, 3, 3])
    setFrame(360, 640)
    video.dispatchEvent(new Event('resize'))
    expect(packets()).toHaveLength(4)
    expect(input.sendTouch(0, 420, 230, 1, video)).toBe(false)
    input.setChannel(channel)
    expect(input.sendTouch(0, 420, 230, 1, video)).toBe(false)
    input.setDeviceSize(800, 1280)
    expect(input.sendTouch(0, 420, 230, 1, video)).toBe(true)
    expect(packets()[4]).toMatchObject({ action: 0, w: 800, h: 1280 })
  })

  it('forgets gestures even if teardown cancellation cannot reach a closed channel', () => {
    const { input, channel, packets } = createReadyInput()
    const { video } = createVideo()
    input.sendTouch(0, 420, 230, 1, video)
    channel.readyState = 'closed'
    expect(input.sendTouch(0, 420, 230, 2, video)).toBe(false)
    input.setChannel(null)
    channel.readyState = 'open'
    input.setChannel(channel)
    expect(input.sendTouch(1, 420, 230, 1, video)).toBe(false)
    expect(packets().map(packet => packet.action)).toEqual([0])
  })
})

describe('send failures and input backpressure', () => {
  it('does not retain a press rejected by channel.send', () => {
    const { input, channel, packets } = createReadyInput()
    const { video, setFrame } = createVideo()
    channel.send.mockImplementationOnce(() => { throw new Error('send failed') })
    expect(input.sendTouch(0, 420, 230, 1, video)).toBe(false)
    expect(input.sendTouch(2, 420, 230, 1, video)).toBe(false)
    expect(input.sendTouch(1, 420, 230, 1, video)).toBe(false)
    setFrame(360, 640)
    video.dispatchEvent(new Event('resize'))
    expect(packets()).toHaveLength(1)
    expect(input.sendTouch(0, 420, 230, 1, video)).toBe(true)
  })

  it('can release after a failed move without inventing another press', () => {
    const { input, channel, packets } = createReadyInput()
    const { video } = createVideo()
    input.sendTouch(0, 420, 230, 1, video)
    channel.send.mockImplementationOnce(() => { throw new Error('send failed') })
    expect(input.sendTouch(2, 580, 140, 1, video)).toBe(false)
    expect(input.sendTouch(1, NaN, NaN, 1, null)).toBe(true)
    expect(packets()[2]).toMatchObject({ action: 1, x: 960, y: 180 })
  })

  it('retains a failed release so teardown can retry cancellation in its original space', () => {
    const { input, channel, packets } = createReadyInput()
    const { video, setFrame } = createVideo()
    input.sendTouch(0, 580, 140, 1, video)
    channel.send.mockImplementationOnce(() => { throw new Error('send failed') })
    expect(input.sendTouch(1, 580, 140, 1, video)).toBe(false)
    setFrame(360, 640)
    video.dispatchEvent(new Event('resize'))
    expect(packets()).toHaveLength(2)

    input.reset()
    expect(packets()).toEqual([
      expect.objectContaining({ action: 0, x: 960, y: 180, w: 1280, h: 720 }),
      expect.objectContaining({ action: 1, x: 960, y: 180, w: 1280, h: 720 }),
      expect.objectContaining({ action: 3, x: 960, y: 180, w: 1280, h: 720 }),
    ])
    input.reset()
    expect(packets()).toHaveLength(3)
  })

  it('retries failed cancellation without replaying subsequent moves', () => {
    const { input, channel, packets } = createReadyInput()
    const { video } = createVideo()
    input.sendTouch(0, 420, 230, 1, video)
    channel.send.mockImplementationOnce(() => { throw new Error('send failed') })
    expect(input.sendTouch(3, 420, 230, 1, video)).toBe(false)
    channel.send.mockImplementationOnce(() => { throw new Error('still blocked') })
    expect(input.sendTouch(2, 580, 140, 1, video)).toBe(false)
    expect(input.sendTouch(2, 580, 140, 1, video)).toBe(false)
    expect(input.sendTouch(2, 580, 140, 1, video)).toBe(false)
    expect(packets().map(packet => packet.action)).toEqual([0, 3, 3, 3])
    expect(packets().slice(1)).toEqual([
      expect.objectContaining({ x: 640, y: 360 }),
      expect.objectContaining({ x: 640, y: 360 }),
      expect.objectContaining({ x: 640, y: 360 }),
    ])
  })

  it.each([1, 3])('requires successful cancellation after failed action %i before a new press', action => {
    const { input, channel, packets } = createReadyInput()
    const { video } = createVideo()
    input.sendTouch(0, 420, 230, 1, video)
    channel.send.mockImplementationOnce(() => { throw new Error('send failed') })
    expect(input.sendTouch(action, 420, 230, 1, video)).toBe(false)
    channel.send.mockImplementationOnce(() => { throw new Error('cancel failed') })
    expect(input.sendTouch(0, 580, 140, 1, video)).toBe(false)
    expect(packets().map(packet => packet.action)).toEqual([0, action, 3])

    expect(input.sendTouch(0, 580, 140, 1, video)).toBe(true)
    expect(packets().map(packet => packet.action)).toEqual([0, action, 3, 3, 0])
    expect(packets()[3]).toMatchObject({ x: 640, y: 360 })
    expect(packets()[4]).toMatchObject({ x: 960, y: 180 })
  })

  it.each(['reset', 'channel replacement'])('clears ending gestures after %s even if cancellation still fails', boundary => {
    const { input, channel, packets } = createReadyInput()
    const next = createChannel()
    const { video } = createVideo()
    input.sendTouch(0, 420, 230, 1, video)
    channel.send.mockImplementationOnce(() => { throw new Error('send failed') })
    expect(input.sendTouch(1, 420, 230, 1, video)).toBe(false)
    channel.send.mockImplementationOnce(() => { throw new Error('cancel failed') })
    if (boundary === 'reset') input.reset()
    input.setChannel(next.channel)
    expect(packets().map(packet => packet.action)).toEqual([0, 1, 3])
    expect(input.sendTouch(1, 420, 230, 1, video)).toBe(false)
    expect(input.sendTouch(2, 420, 230, 1, video)).toBe(false)
    expect(next.packets()).toEqual([])
  })

  it.each([1, 3])('preserves action %i when queued moves exceed the backpressure limit', action => {
    const { input, channel, packets } = createReadyInput()
    const { video } = createVideo()
    input.sendTouch(0, 420, 230, 1, video)
    channel.bufferedAmount = 64 * 1024 + 1
    expect(input.sendTouch(2, 580, 140, 1, video)).toBe(false)
    expect(packets()).toHaveLength(1)
    expect(input.sendTouch(action, 420, 230, 1, video)).toBe(true)
    expect(packets().map(packet => packet.action)).toEqual([0, action])
  })

  it('resumes an active pointer when the channel drains', () => {
    const { input, channel, packets } = createReadyInput()
    const { video } = createVideo()
    input.sendTouch(0, 420, 230, 1, video)
    channel.bufferedAmount = 64 * 1024 + 1
    expect(input.sendTouch(2, 580, 140, 1, video)).toBe(false)
    channel.bufferedAmount = 0
    expect(input.sendTouch(2, 580, 140, 1, video)).toBe(true)
    expect(packets()[1]).toMatchObject({ action: 2, id: 1, x: 960, y: 180 })
  })
})
