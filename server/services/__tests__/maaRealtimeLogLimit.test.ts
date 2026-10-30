import assert from 'node:assert/strict';
import test from 'node:test';

// 环境变量在模块导入时读取；非法值必须回落 5000，而不是 NaN 让裁剪失效。
process.env.LA_PLUMA_MAX_REALTIME_LOGS = 'not-a-number';

const { clearRealtimeLogs, getTaskStatus, setTaskStatus } = await import('../maaProcessService.ts');
const { loggerManager } = await import('../../utils/logger.ts');

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
  clearRealtimeLogs();
});
