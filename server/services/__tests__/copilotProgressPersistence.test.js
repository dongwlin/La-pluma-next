import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// 两个服务模块都在导入时绑定进度文件路径：先建临时目录并注入覆盖变量，
// 再动态导入被测模块；测试运行器逐文件、逐进程执行，不会影响其他用例。
const tempDir = await mkdtemp(join(tmpdir(), 'la-pluma-progress-persistence-'));
process.env.LA_PLUMA_COPILOT_PROGRESS_STORE = join(tempDir, 'copilot-progress.json');
process.env.LA_PLUMA_ACTIVITY_COPILOT_PROGRESS_STORE = join(tempDir, 'activity-copilot-progress.json');

const { resetCopilotPlanProgress } = await import('../copilotPlanService.js');
const { getActivityCompletion, recordActivityCompletion } = await import('../activityCopilotRunService.js');

const planProgressPath = process.env.LA_PLUMA_COPILOT_PROGRESS_STORE;
const activityProgressPath = process.env.LA_PLUMA_ACTIVITY_COPILOT_PROGRESS_STORE;

after(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

test('copilot plan progress reset removes only the target set from a legacy file', async () => {
  await writeFile(planProgressPath, JSON.stringify({ '42': ['0:10:normal'], '43': ['1:11:raid'] }, null, 2), 'utf8');

  assert.deepEqual(await resetCopilotPlanProgress('42'), { success: true });
  assert.deepEqual(
    JSON.parse(await readFile(planProgressPath, 'utf8')),
    { '43': ['1:11:raid'] }
  );
});

test('concurrent copilot plan resets keep each other and other sets', async () => {
  await writeFile(planProgressPath, JSON.stringify({ '1': ['a'], '2': ['b'], '3': ['c'] }, null, 2), 'utf8');

  await Promise.all([resetCopilotPlanProgress('1'), resetCopilotPlanProgress('2')]);

  assert.deepEqual(JSON.parse(await readFile(planProgressPath, 'utf8')), { '3': ['c'] });
});

test('activity completion reads legacy progress files', async () => {
  await writeFile(activityProgressPath, JSON.stringify({
    BD: { stages: ['BD-1'], updatedAt: '2026-01-01T00:00:00.000Z' }
  }, null, 2), 'utf8');

  const completion = await getActivityCompletion({ code: 'BD', stages: ['BD-1', 'BD-2'] });
  assert.equal(completion.complete, false);
  assert.deepEqual(completion.completedStages, ['BD-1']);
});

test('concurrent activity completions for different codes keep both', async () => {
  await writeFile(activityProgressPath, JSON.stringify({}, null, 2), 'utf8');

  await Promise.all([
    recordActivityCompletion({ code: 'bd' }, [{ displayStage: 'BD-1', success: true }]),
    recordActivityCompletion({ code: 'RO' }, [{ displayStage: 'RO-1', success: true }])
  ]);

  const progress = JSON.parse(await readFile(activityProgressPath, 'utf8'));
  assert.deepEqual(progress.BD, { stages: ['BD-1'], updatedAt: progress.BD.updatedAt });
  assert.deepEqual(progress.RO, { stages: ['RO-1'], updatedAt: progress.RO.updatedAt });
  assert.match(progress.BD.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('activity completion drops failed entries and keeps prior stages', async () => {
  await writeFile(activityProgressPath, JSON.stringify({
    BD: { stages: ['BD-1'], updatedAt: '2026-01-01T00:00:00.000Z' }
  }, null, 2), 'utf8');

  await recordActivityCompletion({ code: 'BD' }, [
    { displayStage: 'BD-2', success: true },
    { displayStage: 'BD-3', success: false }
  ]);

  assert.deepEqual(
    JSON.parse(await readFile(activityProgressPath, 'utf8')).BD.stages,
    ['BD-1', 'BD-2']
  );
});

test('corrupted progress files surface errors instead of empty progress', async () => {
  await writeFile(activityProgressPath, 'not-json', 'utf8');

  await assert.rejects(
    getActivityCompletion({ code: 'BD', stages: ['BD-1'] }),
    /读取 JSON 文件失败/
  );
  await assert.rejects(
    recordActivityCompletion({ code: 'BD' }, [{ displayStage: 'BD-1', success: true }]),
    /读取 JSON 文件失败/
  );
  // 损坏内容保持原样，不被空进度覆盖。
  assert.equal(await readFile(activityProgressPath, 'utf8'), 'not-json');
});
