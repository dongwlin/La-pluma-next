import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConnectionCheck,
  buildDiagnosticChecks,
  buildDiagnosticsConclusion,
  buildDiagnosticsReport,
  buildExecutionCheck,
  buildResourceCheck,
  buildRuntimeCheck,
  summarizeDiagnostics
} from '../diagnosticsService.ts';
import type {
  ConnectionProbe,
  DiagnosticCheck,
  DiagnosticsProbes,
  ExecutionProbe,
  ResourceProbe,
  RuntimeProbe
} from '../diagnosticsService.ts';
import type { ResourceInfo } from '../resourceUpdateService.ts';

function resourceInfo(overrides: Partial<ResourceInfo> = {}): ResourceInfo {
  return {
    lastUpdated: '2026-10-30T00:00:00Z',
    modifiedAt: '2026-10-30T00:00:00Z',
    ageDays: 7,
    status: 'current',
    message: '资源版本正常',
    activity: null,
    gacha: null,
    ...overrides
  };
}

function runtimeProbe(overrides: Partial<RuntimeProbe> = {}): RuntimeProbe {
  return { version: { cli: 'v0.7.0', core: 'v6.2.3' }, error: null, ...overrides };
}

function connectionProbe(overrides: Partial<ConnectionProbe> = {}): ConnectionProbe {
  return {
    adbPath: '/platform-tools/adb',
    address: '127.0.0.1:7555',
    connected: true,
    message: '已连接到 127.0.0.1:7555',
    devices: 'List of devices attached\n127.0.0.1:7555\tdevice product:arknights model:MuMu device:x86\n',
    foreground: 'com.hypergryph.arknights/.MainActivity',
    error: null,
    ...overrides
  };
}

function resourceProbe(overrides: Partial<ResourceProbe> = {}): ResourceProbe {
  return {
    info: resourceInfo(),
    error: null,
    directories: [{
      directory: '/maa/resource',
      versionPath: '/maa/resource/version.json',
      missing: []
    }],
    ...overrides
  };
}

function executionProbe(overrides: Partial<ExecutionProbe> = {}): ExecutionProbe {
  return {
    command: 'startup',
    preflightError: null,
    task: { isRunning: false, taskName: null, taskType: null },
    lease: { state: 'free', taskName: null, source: null, reason: null },
    ...overrides
  };
}

function makeProbes(overrides: Partial<DiagnosticsProbes> = {}): DiagnosticsProbes {
  return {
    runtime: runtimeProbe(),
    connection: connectionProbe(),
    resource: resourceProbe(),
    execution: executionProbe(),
    ...overrides
  };
}

function check(status: DiagnosticCheck['status'], title: string, summary: string): DiagnosticCheck {
  return { id: 'runtime', title, status, summary, details: [] };
}

describe('buildRuntimeCheck', () => {
  it('passes when maa-cli and MaaCore versions are readable', () => {
    const result = buildRuntimeCheck(runtimeProbe());

    assert.equal(result.id, 'runtime');
    assert.equal(result.status, 'pass');
    assert.match(result.summary, /maa-cli v0\.7\.0/);
    assert.match(result.summary, /MaaCore v6\.2\.3/);
    assert.deepEqual(result.details, ['maa-cli: v0.7.0', 'MaaCore: v6.2.3']);
    assert.equal(result.hint, undefined);
  });

  it('fails and points at installation when the version probe throws', () => {
    const result = buildRuntimeCheck({ version: null, error: 'spawn maa ENOENT' });

    assert.equal(result.status, 'fail');
    assert.match(result.summary, /无法读取 MAA 版本/);
    assert.deepEqual(result.details, ['error: spawn maa ENOENT']);
    assert.match(result.hint ?? '', /maa install/);
  });

  it('warns when only one of the two versions is readable', () => {
    const result = buildRuntimeCheck({ version: { cli: 'v0.7.0', core: '' }, error: null });

    assert.equal(result.status, 'warn');
    assert.match(result.summary, /版本信息不完整/);
    assert.ok(result.details.includes('MaaCore: 未读取到'));
  });
});

describe('buildConnectionCheck', () => {
  it('passes with address, devices summary, foreground package and locations', () => {
    const result = buildConnectionCheck(connectionProbe());

    assert.equal(result.id, 'connection');
    assert.equal(result.status, 'pass');
    assert.equal(result.summary, 'ADB 已连接（127.0.0.1:7555）');
    assert.ok(result.details.includes('address: 127.0.0.1:7555'));
    assert.ok(result.details.some(detail => detail.startsWith('devices: 127.0.0.1:7555')));
    assert.ok(result.details.includes('foreground: com.hypergryph.arknights/.MainActivity'));
    assert.deepEqual(result.locations, ['/platform-tools/adb', '127.0.0.1:7555']);
  });

  it('fails when the device is not connected', () => {
    const result = buildConnectionCheck(connectionProbe({
      connected: false,
      message: '无法连接到 127.0.0.1:7555，请确保模拟器已启动'
    }));

    assert.equal(result.status, 'fail');
    assert.equal(result.summary, 'ADB 未连接（127.0.0.1:7555）');
    assert.match(result.hint ?? '', /模拟器/);
    assert.deepEqual(result.locations, ['/platform-tools/adb', '127.0.0.1:7555']);
  });

  it('keeps the probe error text in details instead of the summary', () => {
    const result = buildConnectionCheck(connectionProbe({
      connected: false,
      devices: '',
      foreground: null,
      error: 'ADB 路径包含非法字符'
    }));

    assert.equal(result.status, 'fail');
    assert.equal(result.summary, 'ADB 连接探测失败（127.0.0.1:7555）');
    assert.ok(result.details.includes('error: ADB 路径包含非法字符'));
    assert.ok(result.details.includes('devices: 无设备'));
    assert.ok(result.details.includes('foreground: 未读取到'));
  });
});

describe('buildResourceCheck', () => {
  it('passes for a current version with complete directories', () => {
    const result = buildResourceCheck(resourceProbe());

    assert.equal(result.id, 'resource');
    assert.equal(result.status, 'pass');
    assert.equal(result.summary, 'MAA 资源版本正常');
    assert.ok(result.details.includes('status: current'));
    assert.ok(result.details.includes('lastUpdated: 2026-10-30T00:00:00Z'));
    assert.ok(result.details.includes('ageDays: 7'));
    assert.ok(result.details.includes('message: 资源版本正常'));
    assert.deepEqual(result.locations, ['/maa/resource', '/maa/resource/version.json']);
    assert.equal(result.hint, undefined);
  });

  it('warns for a stale resource version', () => {
    const result = buildResourceCheck(resourceProbe({
      info: resourceInfo({ status: 'stale', ageDays: 30, message: '资源已 30 天未更新，建议立即同步' })
    }));

    assert.equal(result.status, 'warn');
    assert.equal(result.summary, 'MAA 资源已 30 天未更新');
    assert.match(result.hint ?? '', /hot-update/);
  });

  it('warns when the version age cannot be read', () => {
    const result = buildResourceCheck(resourceProbe({
      info: resourceInfo({ status: 'unknown', ageDays: null, lastUpdated: null })
    }));

    assert.equal(result.status, 'warn');
    assert.match(result.summary, /无法确认 MAA 资源版本/);
    assert.ok(result.details.includes('ageDays: 未知'));
  });

  it('warns and lists missing key entries for incomplete directories', () => {
    const result = buildResourceCheck(resourceProbe({
      directories: [{
        directory: '/maa/resource',
        versionPath: '/maa/resource/version.json',
        missing: ['version.json', 'template']
      }]
    }));

    assert.equal(result.status, 'warn');
    assert.equal(result.summary, 'MAA 资源目录缺少关键条目');
    assert.ok(result.details.includes('missing: /maa/resource 下 version.json、template'));
  });

  it('fails when the resource version cannot be read', () => {
    const result = buildResourceCheck({
      info: null,
      error: 'ENOENT: version.json',
      directories: [{
        directory: '/maa/resource',
        versionPath: '/maa/resource/version.json',
        missing: ['version.json']
      }]
    });

    assert.equal(result.status, 'fail');
    assert.equal(result.summary, '无法读取 MAA 资源信息');
    assert.ok(result.details.includes('error: ENOENT: version.json'));
    assert.deepEqual(result.locations, ['/maa/resource', '/maa/resource/version.json']);
  });

  it('omits locations when no resource directory could be resolved', () => {
    const result = buildResourceCheck({ info: null, error: '无法读取 MAA 资源版本', directories: [] });

    assert.equal(result.status, 'fail');
    assert.equal(result.locations, undefined);
  });
});

describe('buildExecutionCheck', () => {
  it('fails an invalid command and lists the allowed commands', () => {
    const result = buildExecutionCheck(executionProbe({
      command: 'not-a-command',
      preflightError: {
        message: '不允许的 command: not-a-command',
        allowed: ['startup', 'fight', 'run']
      }
    }));

    assert.equal(result.id, 'execution');
    assert.equal(result.status, 'fail');
    assert.match(result.summary, /任务参数预检失败（not-a-command）/);
    assert.ok(result.details.includes('error: 不允许的 command: not-a-command'));
    assert.ok(result.details.includes('allowed: startup, fight, run'));
    assert.ok(result.details.includes('command: not-a-command'));
  });

  it('warns while a task is running and reports its name and type', () => {
    const result = buildExecutionCheck(executionProbe({
      task: { isRunning: true, taskName: '理智作战', taskType: 'fight' }
    }));

    assert.equal(result.status, 'warn');
    assert.equal(result.summary, '正在执行任务，新任务需要等待');
    assert.ok(result.details.includes('taskName: 理智作战'));
    assert.ok(result.details.includes('taskType: fight'));
    assert.match(result.hint ?? '', /等待当前任务/);
  });

  it('warns when the execution lease is held by another owner', () => {
    const result = buildExecutionCheck(executionProbe({
      lease: { state: 'held', taskName: '调度执行', source: 'scheduler', reason: null }
    }));

    assert.equal(result.status, 'warn');
    assert.ok(result.details.includes('lease: 被占用'));
    assert.ok(result.details.includes('leaseTaskName: 调度执行'));
    assert.ok(result.details.includes('leaseSource: scheduler'));
  });

  it('warns when the execution lease cannot be verified', () => {
    const result = buildExecutionCheck(executionProbe({
      lease: { state: 'unknown', taskName: null, source: null, reason: 'invalid_json' }
    }));

    assert.equal(result.status, 'warn');
    assert.ok(result.details.includes('lease: 无法核实'));
    assert.ok(result.details.includes('leaseReason: invalid_json'));
  });

  it('passes when no task runs and the lease is free', () => {
    const result = buildExecutionCheck(executionProbe());

    assert.equal(result.status, 'pass');
    assert.equal(result.summary, '可以开始执行任务');
    assert.ok(result.details.includes('command: startup'));
    assert.ok(result.details.includes('taskName: 无'));
    assert.ok(result.details.includes('taskType: 无'));
    assert.ok(result.details.includes('lease: 空闲'));
  });

  it('passes without preflight when no command is requested', () => {
    const result = buildExecutionCheck(executionProbe({ command: null }));

    assert.equal(result.status, 'pass');
    assert.ok(result.details.includes('command: 未指定，跳过任务参数预检'));
  });

  it('treats a stale lease as reclaimable instead of busy', () => {
    const result = buildExecutionCheck(executionProbe({
      lease: { state: 'stale', taskName: '旧任务', source: 'maa-command', reason: null }
    }));

    assert.equal(result.status, 'pass');
    assert.ok(result.details.includes('lease: 残留可回收'));
  });
});

describe('diagnostics aggregation', () => {
  it('derives ok only for an all-pass status', () => {
    assert.deepEqual(summarizeDiagnostics([
      check('pass', '运行环境', '正常'),
      check('pass', '设备连接', '正常')
    ]), { ok: true, status: 'ok' });
    assert.deepEqual(summarizeDiagnostics([
      check('pass', '运行环境', '正常'),
      check('warn', '设备连接', '未连接')
    ]), { ok: false, status: 'warn' });
    assert.deepEqual(summarizeDiagnostics([
      check('warn', '运行环境', '告警'),
      check('fail', '设备连接', '失败')
    ]), { ok: false, status: 'error' });
    assert.deepEqual(summarizeDiagnostics([
      check('unknown', '资源状态', '无法判断')
    ]), { ok: true, status: 'ok' });
  });

  it('prefers failures in the conclusion, then warnings, then the healthy default', () => {
    assert.equal(buildDiagnosticsConclusion([]), '运行环境正常，可以执行任务');
    assert.equal(
      buildDiagnosticsConclusion([check('pass', '运行环境', '正常')]),
      '运行环境正常，可以执行任务'
    );
    assert.equal(
      buildDiagnosticsConclusion([
        check('warn', '资源状态', '资源已过期'),
        check('pass', '运行环境', '正常')
      ]),
      '发现 1 项警告：资源状态：资源已过期'
    );
    assert.equal(
      buildDiagnosticsConclusion([
        check('warn', '资源状态', '资源已过期'),
        check('fail', '运行环境', '版本不可读'),
        check('fail', '设备连接', 'ADB 未连接')
      ]),
      '发现 2 项异常：运行环境：版本不可读；设备连接：ADB 未连接'
    );
  });

  it('caps the conclusion details and counts the remaining failures', () => {
    const conclusion = buildDiagnosticsConclusion([
      check('fail', 'A', '1'),
      check('fail', 'B', '2'),
      check('fail', 'C', '3'),
      check('fail', 'D', '4')
    ]);

    assert.equal(conclusion, '发现 4 项异常：A：1；B：2；C：3；另有 1 项');
  });
});

describe('buildDiagnosticChecks and buildDiagnosticsReport', () => {
  it('builds the four checks in the documented order', () => {
    const checks = buildDiagnosticChecks(makeProbes());

    assert.deepEqual(checks.map(item => item.id), ['runtime', 'connection', 'resource', 'execution']);
    assert.ok(checks.every(item => item.status === 'pass'));
  });

  it('returns a healthy report when every probe passes', () => {
    const report = buildDiagnosticsReport(makeProbes(), '2026-11-06T00:00:00.000Z');

    assert.equal(report.ok, true);
    assert.equal(report.status, 'ok');
    assert.equal(report.generatedAt, '2026-11-06T00:00:00.000Z');
    assert.equal(report.conclusion, '运行环境正常，可以执行任务');
    assert.deepEqual(report.checks.map(item => item.id), ['runtime', 'connection', 'resource', 'execution']);
  });

  it('returns an error report when a probe fails', () => {
    const report = buildDiagnosticsReport(
      makeProbes({ connection: connectionProbe({ connected: false }) }),
      '2026-11-06T00:00:00.000Z'
    );

    assert.equal(report.ok, false);
    assert.equal(report.status, 'error');
    assert.match(report.conclusion, /^发现 1 项异常：设备连接：ADB 未连接/);
  });

  it('stays in warn status when only warnings are present', () => {
    const report = buildDiagnosticsReport(
      makeProbes({
        execution: executionProbe({ task: { isRunning: true, taskName: '理智作战', taskType: 'fight' } })
      }),
      '2026-11-06T00:00:00.000Z'
    );

    assert.equal(report.ok, false);
    assert.equal(report.status, 'warn');
    assert.match(report.conclusion, /^发现 1 项警告：任务预检：正在执行任务/);
  });
});
