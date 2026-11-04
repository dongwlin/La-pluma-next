import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateGameTaskParams } from '../gameTaskConfigService.ts';

describe('validateGameTaskParams', () => {
  it('rejects an empty OperProgress plan list', () => {
    assert.equal(
      validateGameTaskParams('OperProgress', { plans: [] }),
      'OperProgress.params.plans 至少包含一项培养计划'
    );
  });

  it('rejects an OperProgress plan without any target', () => {
    assert.equal(
      validateGameTaskParams('OperProgress', { plans: [{ name: '阿米娅' }] }),
      'OperProgress.params.plans[0] 至少选择一个培养目标'
    );
    assert.equal(
      validateGameTaskParams('OperProgress', { plans: [{ name: '阿米娅', skill_mastery: [0, 0, 0] }] }),
      'OperProgress.params.plans[0] 至少选择一个培养目标'
    );
  });

  it('accepts a plan targeting elite, skill level or a positive mastery slot', () => {
    for (const plan of [
      { name: '阿米娅', elite: 2 },
      { name: '陈', skill_level: 7 },
      { name: '白面鸮', skill_mastery: [0, 3, 0] },
      { name: '陈', role: 'Unknown', elite: 1, skill_mastery: [0, 0, 0] }
    ]) {
      assert.equal(validateGameTaskParams('OperProgress', { plans: [plan] }), null, JSON.stringify(plan));
    }
  });

  it('keeps the existing OperProgress field messages', () => {
    assert.equal(
      validateGameTaskParams('OperProgress', {}),
      'OperProgress.params.plans 必须是培养计划数组'
    );
    assert.equal(
      validateGameTaskParams('OperProgress', { plans: [null] }),
      'OperProgress.params.plans[0] 必须是对象'
    );
    assert.equal(
      validateGameTaskParams('OperProgress', { plans: [{ name: '陈', elite: 3 }] }),
      'OperProgress.params.plans[0].elite 必须是 1 或 2'
    );
  });

  it('keeps SwitchTheme and other dynamic task types unrestricted', () => {
    assert.equal(validateGameTaskParams('SwitchTheme', { themes: [] }), null);
    assert.equal(
      validateGameTaskParams('SwitchTheme', {}),
      'SwitchTheme.params.themes 必须是主题名称字符串数组'
    );
    assert.equal(validateGameTaskParams('FutureCoreTask', {}), null);
    assert.equal(validateGameTaskParams('FutureCoreTask', { plans: [] }), null);
  });
});
