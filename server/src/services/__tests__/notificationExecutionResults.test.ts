import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskCompletionMessage } from '../notificationService.ts';

describe('structured execution notifications', () => {
  it('marks unconfirmed game outcomes without a success checkmark', () => {
    const message = buildTaskCompletionMessage({
      taskName: '游戏培养流程', totalTasks: 1, successTasks: 1,
      actions: [{ task: '游戏内培养', status: 'success', observed: false, message: '培养进程已完成，游戏结果未确认' }]
    });
    assert.equal(message.level, 'info');
    assert.match(message.title, /游戏结果未确认/);
    assert.match(message.content, /• 游戏内培养:/);
    assert.doesNotMatch(message.content, /✅ 游戏内培养:/);
  });

  it('includes task actions, report results and warnings', () => {
    const message = buildTaskCompletionMessage({
      taskName: '晚间流程',
      totalTasks: 4,
      successTasks: 3,
      skippedTasks: 1,
      duration: 12000,
      actions: [
        { task: '理智作战', status: 'success', message: '作战完成：1-7 × 3；获得 2 种掉落' },
        { task: '自动公招', status: 'success', message: '公招处理完成：开始 1 次招募' },
        { task: '基建换班', status: 'success', message: '基建流程完成：已收取产物' },
        { task: '信用收支', status: 'skipped', message: '未启用好友访问、信用购物或信用作战，已跳过' }
      ],
      reports: [
        { provider: 'penguin', status: 'failed', message: '企鹅物流汇报失败' }
      ],
      warnings: ['存在未识别掉落，未发送汇报']
    });

    assert.equal(message.level, 'warning');
    assert.equal(message.title, '任务完成（部分失败/跳过）');
    assert.match(message.content, /执行结果/);
    assert.match(message.content, /作战完成：1-7 × 3/);
    assert.match(message.content, /公招处理完成/);
    assert.match(message.content, /基建流程完成/);
    assert.match(message.content, /信用收支/);
    assert.match(message.content, /掉落汇报/);
    assert.match(message.content, /执行提示/);
    assert.equal(message.data['汇报失败'], 1);
  });

  it('does not duplicate structured failures in the legacy error section', () => {
    const message = buildTaskCompletionMessage({
      failedTasks: 1,
      actions: [
        { task: '自动公招', status: 'failed', message: '自动公招未能进入公招界面' }
      ],
      errors: [
        { task: '自动公招', error: '自动公招未能进入公招界面' }
      ]
    });

    assert.equal(message.content.match(/自动公招未能进入公招界面/g)?.length, 1);
    assert.doesNotMatch(message.content, /失败任务/);
  });

  it('preserves legacy errors that have no structured action', () => {
    const message = buildTaskCompletionMessage({
      failedTasks: 1,
      errors: [{ task: '未知任务', error: '连接失败' }]
    });

    assert.match(message.content, /失败任务/);
    assert.match(message.content, /未知任务 - 连接失败/);
  });

  it('renders per-operator game task details under the action line', () => {
    const message = buildTaskCompletionMessage({
      taskName: '游戏培养流程', totalTasks: 1, successTasks: 1,
      actions: [{
        task: '游戏内培养', status: 'success', observed: true,
        message: '游戏内培养流程结束：成功 1，失败 2，跳过 1',
        details: [
          { name: '阿米娅', role: 'Caster', result: 'Success', resultDetail: 'Completed', skillMastery: [0, 0, 1] },
          { name: '陈', result: 'Failed', resultDetail: 'ResourceInsufficient' },
          { name: '白面鸮', role: 'Medic', result: 'Skipped', resultDetail: 'TrainingRoomBusy' },
          { name: '银灰', role: 'Unknown', result: 'Failed', resultDetail: 'ChipNotCraftable' },
          { name: '玫兰莎', result: 'Interrupted' }
        ]
      }]
    });

    assert.match(message.content, /✅ 游戏内培养: 游戏内培养流程结束：成功 1，失败 2，跳过 1/);
    assert.match(message.content, /\n {3}◦ 阿米娅（术师）：培养成功（已完成）/);
    assert.match(message.content, /\n {3}◦ 陈：培养失败（材料不足）/);
    assert.match(message.content, /\n {3}◦ 白面鸮（医疗）：训练室已被占用，已跳过/);
    assert.match(message.content, /\n {3}◦ 银灰：培养失败（无法合成芯片）/);
    assert.match(message.content, /\n {3}◦ 玫兰莎：Interrupted/);
  });

  it('renders deferred mastery targets as pending follow-up lines', () => {
    const message = buildTaskCompletionMessage({
      taskName: '游戏培养流程', totalTasks: 1, successTasks: 1,
      actions: [{
        task: '游戏内培养', status: 'success', observed: true,
        message: '游戏内培养流程结束：成功 1，失败 0，跳过 0',
        deferredMastery: [
          { name: '陈', role: 'Warrior', skillMastery: [0, 1, 0] },
          { name: '白面鸮' }
        ]
      }]
    });

    assert.match(message.content, /\n {3}◦ 陈（近卫）：专精目标待处理，需后续运行/);
    assert.match(message.content, /\n {3}◦ 白面鸮：专精目标待处理，需后续运行/);
  });

  it('keeps the previous output when an action has no operator details', () => {
    const message = buildTaskCompletionMessage({
      taskName: '晚间流程', totalTasks: 1, successTasks: 1, duration: 5000,
      actions: [{ task: '理智作战', status: 'success', message: '作战完成：1-7 × 3' }]
    });

    assert.equal(message.level, 'success');
    assert.equal(message.title, '任务完成');
    assert.equal(message.content, '*晚间流程* 执行完成\n\n🔎 *执行结果*\n✅ 理智作战: 作战完成：1-7 × 3');
  });
});
