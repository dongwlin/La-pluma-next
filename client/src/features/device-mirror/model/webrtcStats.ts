interface WebRTCReport extends RTCStats {
  kind?: string
  mediaType?: string
  trackIdentifier?: string
  transportId?: string
  selectedCandidatePairId?: string
  selected?: boolean
  state?: string
  nominated?: boolean
  localCandidateId?: string
  remoteCandidateId?: string
  candidateType?: string
  protocol?: string
  relayProtocol?: string
  currentRoundTripTime?: number
  bytesReceived?: number
  framesDecoded?: number
  packetsLost?: number
  jitterBufferDelay?: number
  jitterBufferEmittedCount?: number
  totalDecodeTime?: number
}

type Reports = ReadonlyMap<string, WebRTCReport>

export interface WebRTCStatsCounters {
  id: string
  timestamp: number
  bytesReceived?: number
  framesDecoded?: number
  jitterBufferDelay?: number
  jitterBufferEmittedCount?: number
  totalDecodeTime?: number
}

export interface WebRTCStatsMetrics {
  fps: number | null
  bitrate: number | null
  rtt: number | null
  connectionType: string
  lostCount: number | null
  jitterBufferMs?: number | null
  decodeMs?: number | null
}

function nonNegative(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function delta(current: number | undefined, previous: number | undefined) {
  return nonNegative(current) && nonNegative(previous) && current >= previous ? current - previous : null
}

function averageMilliseconds(duration: number | null, count: number | null) {
  return duration !== null && count !== null && count > 0 ? duration * 1000 / count : null
}

function selectedPair(reports: Reports, inbound: WebRTCReport | undefined) {
  const transports = inbound?.transportId
    ? [reports.get(inbound.transportId)]
    : [...reports.values()].filter(report => report.type === 'transport')
  const pairIds = new Set(transports.flatMap(transport => transport?.selectedCandidatePairId ? [transport.selectedCandidatePairId] : []))
  if (pairIds.size) {
    const pair = pairIds.size === 1 ? reports.get([...pairIds][0]!) : undefined
    return pair?.type === 'candidate-pair' ? pair : undefined
  }
  // Older browsers expose an explicit selected flag instead of a transport reference.
  // A succeeded/nominated check alone does not identify the currently used pair.
  const selected = [...reports.values()].filter(report => report.type === 'candidate-pair'
    && report.selected === true && (!inbound?.transportId || report.transportId === inbound.transportId))
  return selected.length === 1 ? selected[0] : undefined
}

function connectionType(reports: Reports, pair: WebRTCReport | undefined) {
  const local = pair?.localCandidateId ? reports.get(pair.localCandidateId) : undefined
  const remote = pair?.remoteCandidateId ? reports.get(pair.remoteCandidateId) : undefined
  const relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay'
  if (!relayed && (!local?.candidateType || !remote?.candidateType)) return '--'
  const protocol = local?.protocol || remote?.protocol
  const relayProtocol = [local, remote].filter(candidate => candidate?.candidateType === 'relay')
    .flatMap(candidate => candidate?.relayProtocol ? [candidate.relayProtocol.toUpperCase()] : [])
  const relayDetails = [...new Set(relayProtocol)].join('/')
  return `${protocol ? `${protocol.toUpperCase()} ` : ''}${relayed ? 'relay' : 'p2p'}${relayDetails ? ` / TURN ${relayDetails}` : ''}`
}

export function sampleWebRTCStats(reports: Reports, previous: WebRTCStatsCounters | null, trackId?: string) {
  const videos = [...reports.values()].filter(report => report.type === 'inbound-rtp' && (report.kind || report.mediaType) === 'video')
  const inbound = (trackId ? videos.find(report => report.trackIdentifier === trackId) : undefined)
    || (videos.length === 1 || !trackId ? videos[0] : undefined)
  const pair = selectedPair(reports, inbound)
  const next: WebRTCStatsCounters | null = inbound ? {
    id: inbound.id,
    timestamp: inbound.timestamp,
    bytesReceived: inbound.bytesReceived,
    framesDecoded: inbound.framesDecoded,
    jitterBufferDelay: inbound.jitterBufferDelay,
    jitterBufferEmittedCount: inbound.jitterBufferEmittedCount,
    totalDecodeTime: inbound.totalDecodeTime
  } : null
  const interval = next && previous && next.id === previous.id && nonNegative(next.timestamp) && nonNegative(previous.timestamp) && next.timestamp > previous.timestamp
    ? { current: next, previous, seconds: (next.timestamp - previous.timestamp) / 1000 } : null
  const frames = interval ? delta(interval.current.framesDecoded, interval.previous.framesDecoded) : null
  const bytes = interval ? delta(interval.current.bytesReceived, interval.previous.bytesReceived) : null
  const metrics: WebRTCStatsMetrics = {
    fps: interval && frames !== null ? Math.round(frames / interval.seconds) : null,
    bitrate: interval && bytes !== null ? Math.round(bytes * 8 / interval.seconds / 1000) : null,
    rtt: nonNegative(pair?.currentRoundTripTime) ? Math.round(pair.currentRoundTripTime * 1000) : null,
    connectionType: connectionType(reports, pair),
    lostCount: typeof inbound?.packetsLost === 'number' && Number.isFinite(inbound.packetsLost) ? inbound.packetsLost : null,
    jitterBufferMs: interval ? averageMilliseconds(
      delta(interval.current.jitterBufferDelay, interval.previous.jitterBufferDelay),
      delta(interval.current.jitterBufferEmittedCount, interval.previous.jitterBufferEmittedCount)
    ) : null,
    decodeMs: interval ? averageMilliseconds(
      delta(interval.current.totalDecodeTime, interval.previous.totalDecodeTime), frames
    ) : null
  }
  return { metrics, counters: next }
}
