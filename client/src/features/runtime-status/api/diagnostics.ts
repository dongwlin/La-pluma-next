import {
  API_BASE_URL,
  isRecord,
  readApiResponse,
  type ApiResponse,
} from '@/shared/api'

export const RUNTIME_DIAGNOSTICS_STATUSES = ['ok', 'warn', 'error'] as const
export type RuntimeDiagnosticsStatus = (typeof RUNTIME_DIAGNOSTICS_STATUSES)[number]

export const RUNTIME_DIAGNOSTIC_CHECK_STATUSES = ['pass', 'warn', 'fail', 'unknown'] as const
export type RuntimeDiagnosticCheckStatus = (typeof RUNTIME_DIAGNOSTIC_CHECK_STATUSES)[number]

export const RUNTIME_DIAGNOSTIC_CHECK_IDS = ['runtime', 'connection', 'resource', 'execution'] as const
export type RuntimeDiagnosticCheckId = (typeof RUNTIME_DIAGNOSTIC_CHECK_IDS)[number]

export interface RuntimeDiagnosticCheck {
  id: RuntimeDiagnosticCheckId
  title: string
  status: RuntimeDiagnosticCheckStatus
  summary: string
  details: string[]
  hint?: string
  locations?: string[]
}

export interface RuntimeDiagnosticsReport {
  ok: boolean
  status: RuntimeDiagnosticsStatus
  generatedAt: string
  conclusion: string
  checks: RuntimeDiagnosticCheck[]
}

export const INVALID_DIAGNOSTICS_PAYLOAD_MESSAGE = '诊断结果格式不正确'

const DIAGNOSTICS_STATUS_SET: ReadonlySet<string> = new Set(RUNTIME_DIAGNOSTICS_STATUSES)
const CHECK_STATUS_SET: ReadonlySet<string> = new Set(RUNTIME_DIAGNOSTIC_CHECK_STATUSES)
const CHECK_ID_SET: ReadonlySet<string> = new Set(RUNTIME_DIAGNOSTIC_CHECK_IDS)

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string')

const isOptionalStringArray = (value: unknown): boolean =>
  value === undefined || isStringArray(value)

const isDiagnosticCheck = (value: unknown): value is RuntimeDiagnosticCheck => {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || !CHECK_ID_SET.has(value.id)) return false
  if (typeof value.title !== 'string' || !value.title.trim()) return false
  if (typeof value.status !== 'string' || !CHECK_STATUS_SET.has(value.status)) return false
  if (typeof value.summary !== 'string') return false
  if (!isStringArray(value.details)) return false
  if (value.hint !== undefined && typeof value.hint !== 'string') return false
  return isOptionalStringArray(value.locations)
}

export const isRuntimeDiagnosticsReport = (payload: unknown): payload is RuntimeDiagnosticsReport => {
  if (!isRecord(payload)) return false
  if (typeof payload.ok !== 'boolean') return false
  if (typeof payload.status !== 'string' || !DIAGNOSTICS_STATUS_SET.has(payload.status)) return false
  if (typeof payload.generatedAt !== 'string' || !payload.generatedAt.trim()) return false
  if (typeof payload.conclusion !== 'string') return false
  return Array.isArray(payload.checks) && payload.checks.every(isDiagnosticCheck)
}

export interface FetchAgentDiagnosticsOptions {
  command?: string
  signal?: AbortSignal
}

export async function fetchAgentDiagnostics({
  command,
  signal,
}: FetchAgentDiagnosticsOptions = {}): Promise<ApiResponse<RuntimeDiagnosticsReport>> {
  const trimmed = command?.trim()
  const query = trimmed ? `?command=${encodeURIComponent(trimmed)}` : ''
  return readApiResponse(`${API_BASE_URL}/agent/diagnostics${query}`, {
    signal,
    validate: isRuntimeDiagnosticsReport,
    invalidPayloadMessage: INVALID_DIAGNOSTICS_PAYLOAD_MESSAGE,
  })
}
