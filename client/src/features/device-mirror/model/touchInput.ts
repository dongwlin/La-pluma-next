interface Size { width: number; height: number }
type InputChannel = Pick<RTCDataChannel, 'readyState' | 'bufferedAmount'> & { send(data: string): void }
interface Geometry { actualW: number; actualH: number; offsetX: number; offsetY: number }
interface Gesture {
  video: HTMLVideoElement
  frame: Size
  space: Size
  x: number
  y: number
  ending?: 1 | 3
  stopWatching: () => void
}

const BACKPRESSURE_BYTES = 64 * 1024

export function getRenderedVideoGeometry(
  containerWidth: number, containerHeight: number, videoWidth: number, videoHeight: number
): Geometry | null {
  if (![containerWidth, containerHeight, videoWidth, videoHeight].every(value => Number.isFinite(value) && value > 0)) return null
  const videoRatio = videoWidth / videoHeight
  if (containerWidth / containerHeight > videoRatio) {
    const actualW = containerHeight * videoRatio
    return { actualW, actualH: containerHeight, offsetX: (containerWidth - actualW) / 2, offsetY: 0 }
  }
  const actualH = containerWidth / videoRatio
  return { actualW: containerWidth, actualH, offsetX: 0, offsetY: (containerHeight - actualH) / 2 }
}

export function isPointInsideRenderedVideo(
  clientX: number, clientY: number, rect: Pick<DOMRect, 'left' | 'top'>, geometry: Geometry
) {
  const x = clientX - rect.left - geometry.offsetX
  const y = clientY - rect.top - geometry.offsetY
  return x >= 0 && x <= geometry.actualW && y >= 0 && y <= geometry.actualH
}

export function isTouchMoveBackpressured(action: number, bufferedAmount: number) {
  return action === 2 && bufferedAmount > BACKPRESSURE_BYTES
}

/** Owns the input space for each gesture, including release during media teardown. */
export function createTouchInput() {
  let channel: InputChannel | null = null
  let device: Size | null = null
  let seq = 0
  const gestures = new Map<number, Gesture>()

  function send(action: number, id: number, gesture: Gesture) {
    if (channel?.readyState !== 'open') return false
    try {
      channel.send(JSON.stringify({
        type: 'touch', id, seq: ++seq, client_ts_ms: Date.now(), action,
        x: gesture.x, y: gesture.y, w: gesture.space.width, h: gesture.space.height
      }))
      return true
    } catch {
      return false
    }
  }

  function cancel(id: number, gesture: Gesture) {
    gesture.ending = 3
    gesture.stopWatching()
    const sent = send(3, id, gesture)
    if (sent) gestures.delete(id)
    return sent
  }

  function cancelAll() {
    gestures.forEach((gesture, id) => cancel(id, gesture))
  }

  function setChannel(next: InputChannel | null) {
    if (channel === next) return
    cancelAll()
    gestures.clear()
    channel = next
  }

  function setDeviceSize(width: unknown, height: unknown) {
    const next = typeof width === 'number' && typeof height === 'number'
      && Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
      ? { width, height } : null
    if (device?.width !== next?.width || device?.height !== next?.height) cancelAll()
    device = next
    return device !== null
  }

  function sendTouch(action: number, clientX: number, clientY: number, id: number, video: HTMLVideoElement | null) {
    if (!channel || channel.readyState !== 'open' || ![0, 1, 2, 3].includes(action)) return false
    let gesture = gestures.get(id)
    if (gesture?.ending) {
      const sent = cancel(id, gesture)
      if (!sent || action !== 0) return false
      gesture = undefined
    }
    if (action !== 0 && !gesture) return false
    const release = action === 1 || action === 3
    if (gesture && (gesture.video.videoWidth !== gesture.frame.width || gesture.video.videoHeight !== gesture.frame.height)) {
      cancel(id, gesture)
      return false
    }
    if (action === 3 && gesture) return cancel(id, gesture)
    if (isTouchMoveBackpressured(action, channel.bufferedAmount)) return false
    if (action === 0 && (!device || !video || !video.videoWidth || !video.videoHeight)) return false
    const target = gesture?.video || video
    const rect = target?.getBoundingClientRect()
    const geometry = target && rect && getRenderedVideoGeometry(rect.width, rect.height, target.videoWidth, target.videoHeight)
    if (!geometry || !rect || !Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      if (!release || !gesture) return false
    } else {
      if (action === 0) {
        if (!isPointInsideRenderedVideo(clientX, clientY, rect, geometry)) return false
        if (gesture && !cancel(id, gesture)) return false
        const rotated = (target!.videoWidth > target!.videoHeight) !== (device!.width > device!.height)
        gesture = {
          video: target!, frame: { width: target!.videoWidth, height: target!.videoHeight },
          space: rotated ? { width: device!.height, height: device!.width } : { ...device! },
          x: 0, y: 0, stopWatching: () => {}
        }
      }
      if (!gesture) return false
      gesture.x = Math.max(0, Math.min(gesture.space.width - 1, Math.round(
        (clientX - rect.left - geometry.offsetX) / geometry.actualW * gesture.space.width
      )))
      gesture.y = Math.max(0, Math.min(gesture.space.height - 1, Math.round(
        (clientY - rect.top - geometry.offsetY) / geometry.actualH * gesture.space.height
      )))
    }
    if (!gesture) return false
    if (release) {
      gesture.ending = 1
      gesture.stopWatching()
    }
    if (!send(action, id, gesture)) return false
    if (release) gestures.delete(id)
    if (action === 0) {
      const active = gesture
      const onResize = () => {
        if (active.video.videoWidth !== active.frame.width || active.video.videoHeight !== active.frame.height) cancel(id, active)
      }
      active.video.addEventListener('resize', onResize)
      active.stopWatching = () => active.video.removeEventListener('resize', onResize)
      gestures.set(id, active)
    }
    return true
  }

  return { setChannel, setDeviceSize, sendTouch, reset() { cancelAll(); gestures.clear(); channel = null; device = null } }
}
