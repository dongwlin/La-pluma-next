import type { ResourceInfo } from './resourceUpdateService.ts';

/** 四项运行环境诊断；报告中的顺序与构建顺序一致。 */
export type DiagnosticCheckId = 'runtime' | 'connection' | 'resource' | 'execution';

/** 单项检查结论；`unknown` 表示探测无法判断，不等同于通过。 */
export type DiagnosticCheckStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export type DiagnosticsStatus = 'ok' | 'warn' | 'error';

/** `GET /api/agent/diagnostics` 的单项检查载荷。 */
export interface DiagnosticCheck {
  id: DiagnosticCheckId;
  title: string;
  status: DiagnosticCheckStatus;
  summary: string;
  details: string[];
  hint?: string;
  locations?: string[];
}

/** `GET /api/agent/diagnostics` 的 data 载荷。 */
export interface DiagnosticsReport {
  ok: boolean;
  status: DiagnosticsStatus;
  generatedAt: string;
  conclusion: string;
  checks: DiagnosticCheck[];
}

/** MAA 版本探测结果；失败时 `version` 为 null 并保留可读错误。 */
export interface RuntimeProbe {
  version: { cli: string; core: string } | null;
  error: string | null;
}

/** ADB 连接探测结果；失败时 `connected` 保持 false。 */
export interface ConnectionProbe {
  adbPath: string;
  address: string;
  connected: boolean;
  message: string;
  devices: string;
  foreground: string | null;
  error: string | null;
}

/** 单个 MAA 资源候选目录的关键条目完整性。 */
export interface ResourceDirectoryProbe {
  directory: string;
  versionPath: string;
  missing: readonly string[];
}

/** 资源版本与目录完整性探测结果；任一失败都不抛出。 */
export interface ResourceProbe {
  info: ResourceInfo | null;
  error: string | null;
  directories: readonly ResourceDirectoryProbe[];
}

/** 子进程投影中的任务状态，只取诊断需要展示的字段。 */
export interface ExecutionTaskProbe {
  isRunning: boolean;
  taskName: string | null;
  taskType: string | null;
}

/** 设备执行租约投影；`unknown` 不能当成空闲。 */
export interface ExecutionLeaseProbe {
  state: 'free' | 'held' | 'stale' | 'unknown';
  taskName: string | null;
  source: string | null;
  reason: string | null;
}

/** 任务参数预检失败的可读信息与允许命令。 */
export interface ExecutionPreflightFailure {
  message: string;
  allowed: readonly string[];
}

/** 任务预检探测结果；`command` 为 null 表示调用方未指定要预检的命令。 */
export interface ExecutionProbe {
  command: string | null;
  preflightError: ExecutionPreflightFailure | null;
  task: ExecutionTaskProbe;
  lease: ExecutionLeaseProbe;
}

export interface DiagnosticsProbes {
  runtime: RuntimeProbe;
  connection: ConnectionProbe;
  resource: ResourceProbe;
  execution: ExecutionProbe;
}

const RUNTIME_TITLE = '运行环境';
const CONNECTION_TITLE = '设备连接';
const RESOURCE_TITLE = '资源状态';
const EXECUTION_TITLE = '任务预检';

const RUNTIME_HINT = '请确认已安装 maa-cli 与 MaaCore，可在设置页安装或更新，也可运行 maa install';
const CONNECTION_HINT = '请确认模拟器已启动、连接地址正确，并检查设置页中的 ADB 路径';
const RESOURCE_HINT = '请在设置页同步 MAA 资源，或运行 maa hot-update';
const EXECUTION_HINT = '等待当前任务结束后再提交新的执行';

const CONCLUSION_DETAIL_LIMIT = 3;
const DEVICE_SUMMARY_LIMIT = 160;

function summarizeDevices(devices: string): string {
  const lines = devices
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('List of devices attached'));
  if (lines.length === 0) return 'devices: 无设备';
  const joined = lines.join(' | ');
  return `devices: ${joined.length > DEVICE_SUMMARY_LIMIT ? `${joined.slice(0, DEVICE_SUMMARY_LIMIT - 3)}...` : joined}`;
}

function leaseLabel(state: ExecutionLeaseProbe['state']): string {
  if (state === 'free') return '空闲';
  if (state === 'held') return '被占用';
  if (state === 'stale') return '残留可回收';
  return '无法核实';
}

/** 把 MAA 版本探测映射为 pass/warn/fail，并在失败时给出安装/更新提示。 */
export function buildRuntimeCheck(probe: RuntimeProbe): DiagnosticCheck {
  if (probe.version === null || probe.error !== null) {
    return {
      id: 'runtime',
      title: RUNTIME_TITLE,
      status: 'fail',
      summary: '无法读取 MAA 版本，maa CLI 或 MaaCore 不可用',
      details: [`error: ${probe.error ?? '版本命令没有返回结果'}`],
      hint: RUNTIME_HINT
    };
  }

  const { cli, core } = probe.version;
  const details = [
    `maa-cli: ${cli || '未读取到'}`,
    `MaaCore: ${core || '未读取到'}`
  ];
  if (!cli || !core) {
    return {
      id: 'runtime',
      title: RUNTIME_TITLE,
      status: 'warn',
      summary: 'MAA 版本信息不完整，请确认 CLI 与 MaaCore 均已安装',
      details,
      hint: RUNTIME_HINT
    };
  }
  return {
    id: 'runtime',
    title: RUNTIME_TITLE,
    status: 'pass',
    summary: `MAA 运行环境正常（maa-cli ${cli} / MaaCore ${core}）`,
    details
  };
}

/** 把 ADB 连接探测映射为 pass/fail，并保留地址、设备摘要与前台包名。 */
export function buildConnectionCheck(probe: ConnectionProbe): DiagnosticCheck {
  const locations = [probe.adbPath, probe.address];
  const details = [
    `address: ${probe.address}`,
    `adbPath: ${probe.adbPath}`,
    summarizeDevices(probe.devices),
    `foreground: ${probe.foreground ?? '未读取到'}`,
    `message: ${probe.message || '无'}`
  ];
  if (probe.error !== null) {
    return {
      id: 'connection',
      title: CONNECTION_TITLE,
      status: 'fail',
      summary: `ADB 连接探测失败（${probe.address}）`,
      details: [...details, `error: ${probe.error}`],
      hint: CONNECTION_HINT,
      locations
    };
  }
  if (!probe.connected) {
    return {
      id: 'connection',
      title: CONNECTION_TITLE,
      status: 'fail',
      summary: `ADB 未连接（${probe.address}）`,
      details,
      hint: CONNECTION_HINT,
      locations
    };
  }
  return {
    id: 'connection',
    title: CONNECTION_TITLE,
    status: 'pass',
    summary: `ADB 已连接（${probe.address}）`,
    details,
    locations
  };
}

/** 把资源版本与目录完整性映射为 pass/warn/fail；缺少关键条目只算警告。 */
export function buildResourceCheck(probe: ResourceProbe): DiagnosticCheck {
  const locations = [...new Set(probe.directories.flatMap(item => [item.directory, item.versionPath]))];
  if (probe.info === null || probe.error !== null) {
    return {
      id: 'resource',
      title: RESOURCE_TITLE,
      status: 'fail',
      summary: '无法读取 MAA 资源信息',
      details: [
        `error: ${probe.error ?? '资源目录没有返回版本信息'}`,
        ...probe.directories.map(item => `resourceDir: ${item.directory}`)
      ],
      hint: RESOURCE_HINT,
      ...(locations.length > 0 ? { locations } : {})
    };
  }

  const { info } = probe;
  const missingDetails = probe.directories
    .filter(item => item.missing.length > 0)
    .map(item => `missing: ${item.directory} 下 ${item.missing.join('、')}`);
  const hasMissing = missingDetails.length > 0;
  const details = [
    `status: ${info.status}`,
    `lastUpdated: ${info.lastUpdated ?? '未知'}`,
    `ageDays: ${info.ageDays === null ? '未知' : String(info.ageDays)}`,
    `message: ${info.message}`,
    ...missingDetails
  ];
  const status: DiagnosticCheckStatus = info.status === 'current' && !hasMissing ? 'pass' : 'warn';
  const summary = hasMissing
    ? 'MAA 资源目录缺少关键条目'
    : info.status === 'stale'
      ? (info.ageDays === null ? 'MAA 资源已过期，建议同步资源' : `MAA 资源已 ${info.ageDays} 天未更新`)
      : info.status === 'unknown'
        ? '无法确认 MAA 资源版本，请重新同步资源'
        : 'MAA 资源版本正常';

  return {
    id: 'resource',
    title: RESOURCE_TITLE,
    status,
    summary,
    details,
    ...(status === 'warn' ? { hint: RESOURCE_HINT } : {}),
    ...(locations.length > 0 ? { locations } : {})
  };
}

/** 把任务参数预检、运行中任务与执行租约映射为 pass/warn/fail。 */
export function buildExecutionCheck(probe: ExecutionProbe): DiagnosticCheck {
  if (probe.preflightError !== null) {
    return {
      id: 'execution',
      title: EXECUTION_TITLE,
      status: 'fail',
      summary: probe.command === null ? '任务参数预检失败' : `任务参数预检失败（${probe.command}）`,
      details: [
        `error: ${probe.preflightError.message}`,
        ...(probe.preflightError.allowed.length > 0
          ? [`allowed: ${probe.preflightError.allowed.join(', ')}`]
          : []),
        ...(probe.command === null ? [] : [`command: ${probe.command}`])
      ],
      hint: 'command 仅支持清单中列出的 maa-cli 子命令'
    };
  }

  const details = [
    probe.command === null ? 'command: 未指定，跳过任务参数预检' : `command: ${probe.command}`,
    `taskName: ${probe.task.taskName ?? '无'}`,
    `taskType: ${probe.task.taskType ?? '无'}`,
    `lease: ${leaseLabel(probe.lease.state)}`,
    ...(probe.lease.taskName === null ? [] : [`leaseTaskName: ${probe.lease.taskName}`]),
    ...(probe.lease.source === null ? [] : [`leaseSource: ${probe.lease.source}`]),
    ...(probe.lease.reason === null ? [] : [`leaseReason: ${probe.lease.reason}`])
  ];
  const busy = probe.task.isRunning
    || probe.lease.state === 'held'
    || probe.lease.state === 'unknown';
  if (busy) {
    return {
      id: 'execution',
      title: EXECUTION_TITLE,
      status: 'warn',
      summary: '正在执行任务，新任务需要等待',
      details,
      hint: EXECUTION_HINT
    };
  }
  return {
    id: 'execution',
    title: EXECUTION_TITLE,
    status: 'pass',
    summary: '可以开始执行任务',
    details
  };
}

/** 按 fail 优先、warn 次之的规则聚合整体状态；`ok` 仅在 status 为 `ok` 时为 true。 */
export function summarizeDiagnostics(
  checks: readonly DiagnosticCheck[]
): { ok: boolean; status: DiagnosticsStatus } {
  const failureCount = checks.filter(check => check.status === 'fail').length;
  const warningCount = checks.filter(check => check.status === 'warn').length;
  const status: DiagnosticsStatus = failureCount > 0 ? 'error' : warningCount > 0 ? 'warn' : 'ok';
  return { ok: status === 'ok', status };
}

function describeChecks(checks: readonly DiagnosticCheck[]): string {
  const shown = checks
    .slice(0, CONCLUSION_DETAIL_LIMIT)
    .map(check => `${check.title}：${check.summary}`);
  const remaining = checks.length - shown.length;
  return remaining > 0 ? `${shown.join('；')}；另有 ${remaining} 项` : shown.join('；');
}

/** 失败项优先、其次警告项，全部通过时给出可执行结论。 */
export function buildDiagnosticsConclusion(checks: readonly DiagnosticCheck[]): string {
  const failures = checks.filter(check => check.status === 'fail');
  if (failures.length > 0) return `发现 ${failures.length} 项异常：${describeChecks(failures)}`;
  const warnings = checks.filter(check => check.status === 'warn');
  if (warnings.length > 0) return `发现 ${warnings.length} 项警告：${describeChecks(warnings)}`;
  return '运行环境正常，可以执行任务';
}

/** 按固定顺序组装四项检查。 */
export function buildDiagnosticChecks(probes: DiagnosticsProbes): DiagnosticCheck[] {
  return [
    buildRuntimeCheck(probes.runtime),
    buildConnectionCheck(probes.connection),
    buildResourceCheck(probes.resource),
    buildExecutionCheck(probes.execution)
  ];
}

/** 组装诊断报告；时间由调用方注入，保证纯函数可重复。 */
export function buildDiagnosticsReport(
  probes: DiagnosticsProbes,
  generatedAt: string
): DiagnosticsReport {
  const checks = buildDiagnosticChecks(probes);
  const { ok, status } = summarizeDiagnostics(checks);
  return {
    ok,
    status,
    generatedAt,
    conclusion: buildDiagnosticsConclusion(checks),
    checks
  };
}
