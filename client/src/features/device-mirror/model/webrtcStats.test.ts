import { describe, expect, it } from 'vitest'
import { sampleWebRTCStats, type WebRTCStatsCounters } from './webrtcStats'

type Report = Parameters<typeof sampleWebRTCStats>[0] extends ReadonlyMap<string, infer Value> ? Value : never

const video = {
  id: 'video', type: 'inbound-rtp', timestamp: 2000, kind: 'video', transportId: 'video-transport',
  bytesReceived: 20000, framesDecoded: 30, jitterBufferDelay: 1.5, jitterBufferEmittedCount: 30, totalDecodeTime: 0.12
} satisfies Report
const pair = {
  id: 'pair', type: 'candidate-pair', timestamp: 2000, localCandidateId: 'local', remoteCandidateId: 'remote', currentRoundTripTime: 0.025
} satisfies Report
const transport = { id: 'video-transport', type: 'transport', timestamp: 2000, selectedCandidatePairId: 'pair' } satisfies Report
const local = { id: 'local', type: 'local-candidate', timestamp: 2000, candidateType: 'host', protocol: 'udp' } satisfies Report
const remote = { id: 'remote', type: 'remote-candidate', timestamp: 2000, candidateType: 'host', protocol: 'udp' } satisfies Report
const previous: WebRTCStatsCounters = {
  id: 'video', timestamp: 1000, bytesReceived: 10000, framesDecoded: 10,
  jitterBufferDelay: 0.3, jitterBufferEmittedCount: 10, totalDecodeTime: 0.02
}

function reports(...entries: Report[]) {
  return new Map(entries.map(entry => [entry.id, entry]))
}

describe('WebRTC statistics sampling', () => {
  it('uses the video transport selected pair instead of the first succeeded candidate', () => {
    const sample = sampleWebRTCStats(reports(
      { ...pair, id: 'old-pair', currentRoundTripTime: 0.002, state: 'succeeded', selected: true },
      { ...transport, id: 'data-transport', selectedCandidatePairId: 'old-pair' },
      video, transport, pair, local, remote
    ), previous)
    expect(sample.metrics).toMatchObject({ rtt: 25, connectionType: 'UDP p2p' })
  })

  it('recognizes a relay on the remote side and reports the TURN transport when available', () => {
    const sample = sampleWebRTCStats(reports(video, transport, pair, local, { ...remote, candidateType: 'relay', relayProtocol: 'tcp' }), null)
    expect(sample.metrics).toMatchObject({ rtt: 25, connectionType: 'UDP relay / TURN TCP' })
  })

  it('recognizes a local relay without assuming an unsupported protocol', () => {
    const sample = sampleWebRTCStats(reports(video, transport, pair, { ...local, candidateType: 'relay', protocol: undefined }, { ...remote, protocol: undefined }), null)
    expect(sample.metrics.connectionType).toBe('relay')
  })

  it('uses a legacy explicit selected flag when no transport pair reference is available', () => {
    const sample = sampleWebRTCStats(reports({ ...video, transportId: undefined }, { ...pair, selected: true }, local, remote), null)
    expect(sample.metrics).toMatchObject({ rtt: 25, connectionType: 'UDP p2p' })
  })

  it('does not guess from succeeded or nominated candidates', () => {
    const sample = sampleWebRTCStats(reports(video, { ...pair, state: 'succeeded', nominated: true }, local, remote), null)
    expect(sample.metrics).toMatchObject({ rtt: null, connectionType: '--' })
  })

  it('does not choose an unrelated transport when the video transport report is missing', () => {
    const sample = sampleWebRTCStats(reports(video, { ...transport, id: 'other-transport' }, pair, local, remote), null)
    expect(sample.metrics).toMatchObject({ rtt: null, connectionType: '--' })
  })

  it('does not substitute an old selected candidate for an invalid selected pair reference', () => {
    const sample = sampleWebRTCStats(reports(video, { ...transport, selectedCandidatePairId: 'missing' }, { ...pair, selected: true, transportId: video.transportId }, local, remote), null)
    expect(sample.metrics).toMatchObject({ rtt: null, connectionType: '--' })
  })

  it('leaves the network path unknown when multiple transports are possible without a video reference', () => {
    const sample = sampleWebRTCStats(reports({ ...video, transportId: undefined }, transport, { ...transport, id: 'other', selectedCandidatePairId: 'other-pair' }, pair, local, remote), null)
    expect(sample.metrics).toMatchObject({ rtt: null, connectionType: '--' })
  })

  it('preserves zero RTT and leaves missing candidate metadata unknown', () => {
    const sample = sampleWebRTCStats(reports(video, transport, { ...pair, currentRoundTripTime: 0 }), null)
    expect(sample.metrics).toMatchObject({ rtt: 0, connectionType: '--' })
  })

  it('calculates interval rates and average buffer/decode time from cumulative counters', () => {
    const sample = sampleWebRTCStats(reports(video), previous)
    expect(sample.metrics).toMatchObject({ fps: 20, bitrate: 80 })
    expect(sample.metrics.jitterBufferMs).toBeCloseTo(60)
    expect(sample.metrics.decodeMs).toBeCloseTo(5)
    expect(sample.counters).toMatchObject({ id: video.id, timestamp: 2000, framesDecoded: 30 })
  })

  it('reports unknown intervals on the first sample or a different inbound stream', () => {
    for (const counters of [null, { ...previous, id: 'old-video' }]) {
      expect(sampleWebRTCStats(reports(video), counters).metrics).toMatchObject({ fps: null, bitrate: null, jitterBufferMs: null, decodeMs: null })
    }
  })

  it('starts new counter baselines after reset and never emits negative rates or durations', () => {
    const reset = sampleWebRTCStats(reports({ ...video, bytesReceived: 1, framesDecoded: 1, jitterBufferDelay: 0, jitterBufferEmittedCount: 1, totalDecodeTime: 0 }), previous)
    expect(reset.metrics).toMatchObject({ fps: null, bitrate: null, jitterBufferMs: null, decodeMs: null })
    const recovered = sampleWebRTCStats(reports({ ...video, timestamp: 3000 }), reset.counters)
    expect(recovered.metrics).toMatchObject({ fps: 29, bitrate: 160, decodeMs: 0.12 * 1000 / 29 })
  })

  it('reports zero received frame rate with no new frames but leaves averages unknown', () => {
    const sample = sampleWebRTCStats(reports({ ...video, framesDecoded: previous.framesDecoded, jitterBufferEmittedCount: previous.jitterBufferEmittedCount }), previous)
    expect(sample.metrics).toMatchObject({ fps: 0, jitterBufferMs: null, decodeMs: null })
  })

  it.each([1000, 999, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid sampling intervals with timestamp %s', timestamp => {
    expect(sampleWebRTCStats(reports({ ...video, timestamp }), previous).metrics).toMatchObject({ fps: null, bitrate: null, jitterBufferMs: null, decodeMs: null })
  })

  it('keeps unsupported counters and invalid RTT unknown', () => {
    const sample = sampleWebRTCStats(reports(
      { ...video, bytesReceived: undefined, framesDecoded: undefined, jitterBufferDelay: Number.NaN, totalDecodeTime: Number.POSITIVE_INFINITY },
      transport, { ...pair, currentRoundTripTime: -1 }, local, remote
    ), previous)
    expect(sample.metrics).toMatchObject({ fps: null, bitrate: null, rtt: null, lostCount: null, jitterBufferMs: null, decodeMs: null })
  })

  it('selects the current video track and its transport among multiple inbound streams', () => {
    const sample = sampleWebRTCStats(reports(
      { ...video, id: 'old-video', trackIdentifier: 'old-track', transportId: 'old-transport' },
      { ...video, trackIdentifier: 'live-track' }, transport, pair, local, remote
    ), previous, 'live-track')
    expect(sample.metrics).toMatchObject({ fps: 20, rtt: 25 })
    expect(sample.counters?.id).toBe('video')
  })

  it('clears interval counters when the inbound video is absent', () => {
    const sample = sampleWebRTCStats(reports(transport, pair, local, remote), previous)
    expect(sample.counters).toBeNull()
    expect(sample.metrics).toMatchObject({ fps: null, bitrate: null, rtt: 25, jitterBufferMs: null, decodeMs: null })
  })
})
