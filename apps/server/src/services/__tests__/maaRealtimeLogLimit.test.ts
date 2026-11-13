import assert from 'node:assert/strict';
import test from 'node:test';

// 环境变量在模块导入时读取；非法值必须回落 5000，而不是 NaN 让裁剪失效。
process.env.LA_PLUMA_MAX_REALTIME_LOGS = 'not-a-number';

const { addLog, clearRealtimeLogs, getRealtimeLogs, getTaskStatus, setTaskStatus } = await import('../maaProcessService.ts');
const { loggerManager } = await import('../../utils/logger.ts');
const { withExecutionLogContext } = await import('../../utils/logContext.ts');

loggerManager.getLogger('MaaService').enableConsole = false;

test('an invalid realtime log limit falls back to the 5000-entry buffer', () => {
  clearRealtimeLogs();
  for (let index = 0; index < 5003; index += 1) {
    setTaskStatus(index % 2 === 0, `任务-${index}`, 'automation');
  }
  setTaskStatus(false);

  // 5004 条写入后仍应裁到 5000；NaN 会让 trimRealtimeLogs 的比较永远为 false。
  assert.equal(getTaskStatus().logs.length, 5000);
  assert.equal(getTaskStatus().logs.at(-1)?.message.includes('任务状态更新'), true);
  const retained = getTaskStatus().logs;
  assert.equal(new Set(retained.map(entry => entry.id)).size, 5000);
  assert.equal(retained.at(-1)!.sequence - retained[0]!.sequence, 4999);
  clearRealtimeLogs();
});

test('realtime identities survive repeated snapshots and never repeat after clearing', () => {
  clearRealtimeLogs();
  withExecutionLogContext({ runId: 'run-identity', operationId: 'fight' }, () => {
    addLog('INFO', 'same output token=secret');
    addLog('INFO', 'same output token=secret');
  });

  const first = getRealtimeLogs();
  assert.deepEqual(getRealtimeLogs(), first);
  assert.equal(first.length, 2);
  assert.notEqual(first[0]!.id, first[1]!.id);
  assert.equal(first[1]!.sequence, first[0]!.sequence + 1);
  assert.equal(first[0]!.runId, 'run-identity');
  assert.equal(first[0]!.operationId, 'fight');
  assert.ok(!first[0]!.message.includes('secret'));

  clearRealtimeLogs();
  addLog('INFO', 'same output token=secret');
  const afterClear = getRealtimeLogs();
  assert.equal(afterClear.length, 1);
  assert.notEqual(afterClear[0]!.id, first[1]!.id);
  assert.equal(afterClear[0]!.sequence, first[1]!.sequence + 1);
  assert.equal(afterClear[0]!.runId, undefined);
  clearRealtimeLogs();
});
