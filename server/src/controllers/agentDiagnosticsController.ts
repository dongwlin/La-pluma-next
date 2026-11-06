import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { preflightAgentTaskRequest } from '../services/agentActionService.ts';
import { getMaaExecutionLeaseSnapshot } from '../services/executionCoordinatorService.ts';
import type { MaaExecutionLeaseSnapshot } from '../services/executionCoordinatorService.ts';
import { getMaaVersion } from '../services/maaExecutionService.ts';
import { getTaskStatus } from '../services/maaProcessService.ts';
import { getMaaResourceDirs, getMaaResourceInfo } from '../services/resourceUpdateService.ts';
import type { ResourceInfo } from '../services/resourceUpdateService.ts';
import { buildDiagnosticsReport } from '../services/diagnosticsService.ts';
import type {
  ConnectionProbe,
  DiagnosticsProbes,
  ExecutionPreflightFailure,
  ExecutionProbe,
  ResourceDirectoryProbe,
  ResourceProbe,
  RuntimeProbe
} from '../services/diagnosticsService.ts';
import { sendSuccess } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import { getAdbSummary } from './deviceStatus.ts';
import { readErrorMessage } from './readDto.ts';
import type { ReadRequest } from './readDto.ts';
import { resolveRequestConnection } from './requestConnection.ts';

const RESOURCE_INTEGRITY_ENTRIES = ['version.json', 'tasks', 'template'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readCommandQuery(query: unknown): unknown {
  return isRecord(query) ? query.command : undefined;
}

function readAllowedCommands(error: unknown): string[] {
  if (!isRecord(error) || !isRecord(error.details)) return [];
  const allowed = error.details.allowed;
  return Array.isArray(allowed)
    ? allowed.filter((item): item is string => typeof item === 'string')
    : [];
}

function readCommandLabel(command: unknown): string | null {
  if (command === undefined) return null;
  return typeof command === 'string' ? command : String(command);
}

function readPreflightFailure(command: unknown): ExecutionPreflightFailure | null {
  try {
    preflightAgentTaskRequest({ command });
    return null;
  } catch (error) {
    return {
      message: readErrorMessage(error),
      allowed: readAllowedCommands(error)
    };
  }
}

async function probeRuntime(): Promise<RuntimeProbe> {
  try {
    const version = await getMaaVersion(true);
    return {
      version: { cli: version.cli, core: version.core },
      error: null
    };
  } catch (error) {
    return { version: null, error: readErrorMessage(error) };
  }
}

async function probeConnection(adbPath: string, address: string): Promise<ConnectionProbe> {
  try {
    const summary = await getAdbSummary(adbPath, address);
    return {
      adbPath: summary.adbPath,
      address: summary.address,
      connected: summary.connected,
      message: summary.message,
      devices: summary.devices,
      foreground: summary.foreground,
      error: null
    };
  } catch (error) {
    return {
      adbPath,
      address,
      connected: false,
      message: '',
      devices: '',
      foreground: null,
      error: readErrorMessage(error)
    };
  }
}

async function inspectResourceDirectory(directory: string): Promise<ResourceDirectoryProbe> {
  const entries = await Promise.all(RESOURCE_INTEGRITY_ENTRIES.map(async (entry): Promise<string | null> => {
    const present = await stat(join(directory, entry)).then(() => true).catch(() => false);
    return present ? null : entry;
  }));
  return {
    directory,
    versionPath: join(directory, 'version.json'),
    missing: entries.filter((entry): entry is string => entry !== null)
  };
}

async function probeResource(): Promise<ResourceProbe> {
  const infoPromise = getMaaResourceInfo()
    .then((info): { info: ResourceInfo | null; error: string | null } => ({ info, error: null }))
    .catch((error): { info: null; error: string } => ({ info: null, error: readErrorMessage(error) }));
  const directoriesPromise = getMaaResourceDirs()
    .then(async (directories): Promise<ResourceDirectoryProbe[]> => (
      Promise.all(directories.map(inspectResourceDirectory))
    ))
    .catch((): ResourceDirectoryProbe[] => []);
  const [info, directories] = await Promise.all([infoPromise, directoriesPromise]);
  return { info: info.info, error: info.error, directories };
}

async function probeExecution(command: unknown): Promise<ExecutionProbe> {
  const task = getTaskStatus();
  const lease = await getMaaExecutionLeaseSnapshot().catch((): MaaExecutionLeaseSnapshot => ({
    state: 'unknown',
    owner: null,
    reason: 'lease_snapshot_failed'
  }));
  return {
    command: readCommandLabel(command),
    preflightError: command === undefined ? null : readPreflightFailure(command),
    task: {
      isRunning: task.isRunning,
      taskName: task.taskName,
      taskType: task.taskType
    },
    lease: {
      state: lease.state,
      taskName: lease.owner?.taskName ?? null,
      source: lease.owner?.source ?? null,
      reason: lease.state === 'unknown' ? lease.reason : null
    }
  };
}

/** `/diagnostics`：并行执行四项只读探测，失败信息折入检查项而不是抛错。 */
export async function readDiagnostics(req: ReadRequest, res: ApiResponseWriter): Promise<void> {
  const connection = await resolveRequestConnection(req, { allowOverrides: true });
  const command = readCommandQuery(req.query);
  const [runtime, connectionProbe, resource, execution] = await Promise.all([
    probeRuntime(),
    probeConnection(connection.adbPath, connection.address),
    probeResource(),
    probeExecution(command)
  ]);
  const probes: DiagnosticsProbes = {
    runtime,
    connection: connectionProbe,
    resource,
    execution
  };
  return sendSuccess(res, req, buildDiagnosticsReport(probes, new Date().toISOString()));
}
