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

describe('validateGameTaskParams for daily task types', () => {
  it('accepts the full fight series range and rejects values outside it', () => {
    for (const series of [-1, 0, 1, 10, '5']) {
      assert.equal(validateGameTaskParams('Fight', { series }), null, String(series));
    }
    assert.equal(validateGameTaskParams('Fight', { series: 11 }), 'Fight.params.series 必须是 -1 至 10 的整数');
    assert.equal(validateGameTaskParams('Fight', { series: -2 }), 'Fight.params.series 必须是 -1 至 10 的整数');
    assert.equal(validateGameTaskParams('Fight', { series: 1.5 }), 'Fight.params.series 必须是整数');
  });

  it('accepts expiry-day and legacy bottle-count medicine options', () => {
    assert.equal(validateGameTaskParams('Fight', { medicine_expire_days: 0 }), null);
    assert.equal(validateGameTaskParams('Fight', { medicineExpireDays: '3' }), null);
    assert.equal(validateGameTaskParams('Fight', { expiring_medicine: 2 }), null);
    assert.equal(
      validateGameTaskParams('Fight', { medicine_expire_days: -1 }),
      'Fight.params.medicine_expire_days 不能小于 0'
    );
  });

  it('keeps force_refresh valid and checks the permit reserve and tag strategy', () => {
    assert.equal(validateGameTaskParams('Recruit', {
      refresh: true,
      force_refresh: true,
      level3_recruitment_permit_reserve: 8,
      extra_tags_mode: 2,
      times: 0
    }), null);
    assert.equal(validateGameTaskParams('Recruit', { force_refresh: true }), null);
    assert.equal(
      validateGameTaskParams('Recruit', { force_refresh: 'yes' }),
      'Recruit.params.force_refresh 必须是布尔值'
    );
    assert.equal(
      validateGameTaskParams('Recruit', { level3_recruitment_permit_reserve: -1 }),
      'Recruit.params.level3_recruitment_permit_reserve 不能小于 0'
    );
    assert.equal(
      validateGameTaskParams('Recruit', { extra_tags_mode: 3 }),
      'Recruit.params.extra_tags_mode 必须是 0、1 或 2'
    );
  });

  it('validates infrast facilities, modes and award sign-in switches', () => {
    assert.equal(validateGameTaskParams('Infrast', {
      mode: 0,
      facility: ['Mfg', 'Recycle', 'Processing', 'AssistantChange']
    }), null);
    assert.match(
      validateGameTaskParams('Infrast', { mode: 123, facility: ['Mfg'] }) ?? '',
      /mode/
    );
    assert.match(
      validateGameTaskParams('Infrast', { mode: 0, facility: ['Unknown'] }) ?? '',
      /facility/
    );
    assert.equal(validateGameTaskParams('Award', { award: true, signinevent: true }), null);
    assert.equal(
      validateGameTaskParams('Award', { signinevent: 'yes' }),
      'Award.params.signinevent 必须是布尔值'
    );
  });

  it('validates the startup launch switch and account parameters', () => {
    assert.equal(validateGameTaskParams('StartUp', {
      client_type: 'Official',
      account_name: '4567',
      start_game_enabled: false
    }), null);
    assert.equal(validateGameTaskParams('StartUp', {
      clientType: 'Bilibili',
      accountName: '',
      start_game_enabled: true
    }), null);
    assert.equal(
      validateGameTaskParams('StartUp', { start_game_enabled: 'no' }),
      'StartUp.params.start_game_enabled 必须是布尔值'
    );
    assert.equal(
      validateGameTaskParams('StartUp', { client_type: 'Unknown' }),
      'StartUp.params.client_type 必须是 Official/Bilibili/Txwy/YoStarEN/YoStarJP/YoStarKR 之一'
    );
  });
});
