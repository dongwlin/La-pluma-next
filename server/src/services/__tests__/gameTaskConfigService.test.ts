import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGameTaskParams,
  validateGameTaskParams,
  validateRoguelikeCommandArgs
} from '../gameTaskConfigService.ts';

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

describe('validateGameTaskParams Roguelike', () => {
  it('accepts themes, modes and mode-specific parameters of the Core protocol', () => {
    for (const params of [
      {},
      { theme: 'Phantom', mode: 0 },
      { theme: 'Sami', mode: 5, expected_collapsal_paradigms: ['目空一些'] },
      { theme: 'Sarkaz', mode: 10001 },
      { theme: 'JieGarden', mode: 20001, find_playTime_target: 2 },
      {
        theme: 'BlackFlow',
        mode: 30003,
        blackflow_start_animals: ['swaddled_cat', 'swaddled_dog'],
        blackflow_start_rewards: 3
      },
      { theme: 'BlackFlow', mode: 30001, blackflow_cultivation_target: 'swaddled_dog' },
      { theme: 'BlackFlow', mode: 30003, blackflow_start_animals: [], blackflow_start_rewards: 0 },
      {
        theme: 'BlackFlow',
        mode: 30003,
        blackflow_start_animals: ['swaddled_cat'],
        blackflow_start_rewards: 1,
        blackflow_start_utopia: true,
        blackflow_start_reward_priority: ['unnumbered_item', 'pegasus']
      },
      {
        theme: 'Phantom',
        mode: 4,
        start_with_elite_two: true,
        only_start_with_elite_two: true,
        core_char_list: [{ name: '维什戴尔', use_support: true }]
      }
    ]) {
      assert.equal(validateGameTaskParams('Roguelike', params), null, JSON.stringify(params));
    }
  });

  it('rejects unknown themes and modes that do not belong to the theme', () => {
    assert.equal(
      validateGameTaskParams('Roguelike', { theme: 'Unknown' }),
      'Roguelike.params.theme 必须是 Phantom、Mizuki、Sami、Sarkaz、JieGarden、BlackFlow 之一'
    );
    assert.equal(
      validateGameTaskParams('Roguelike', { theme: 'Sami', mode: 10001 }),
      'Roguelike.params.mode 10001 不适用于 Sami 主题，可选：0、1、4、6、7、5'
    );
    assert.equal(
      validateGameTaskParams('Roguelike', { theme: 'BlackFlow', mode: 5 }),
      'Roguelike.params.mode 5 不适用于 BlackFlow 主题，可选：0、1、30001、30003'
    );
    assert.equal(
      validateGameTaskParams('Roguelike', { mode: '1' }),
      'Roguelike.params.mode 必须是整数'
    );
  });

  it('rejects malformed field types', () => {
    assert.equal(
      validateGameTaskParams('Roguelike', { use_support: 'yes' }),
      'Roguelike.params.use_support 必须是布尔值'
    );
    assert.equal(
      validateGameTaskParams('Roguelike', { squad: 1 }),
      'Roguelike.params.squad 必须是字符串'
    );
    assert.equal(
      validateGameTaskParams('Roguelike', { starts_count: 1.5 }),
      'Roguelike.params.starts_count 必须是整数'
    );
    assert.equal(
      validateGameTaskParams('Roguelike', { start_foldartal_list: '英雄' }),
      'Roguelike.params.start_foldartal_list 必须是字符串数组'
    );
    assert.equal(
      validateGameTaskParams('Roguelike', { core_char_list: [{ name: 1 }] }),
      'Roguelike.params.core_char_list 必须是 { name, use_support? } 对象数组'
    );
    assert.equal(
      validateGameTaskParams('Roguelike', { collectible_mode_start_list: { hot_water: 'yes' } }),
      'Roguelike.params.collectible_mode_start_list.hot_water 必须是布尔值'
    );
  });

  it('rejects missing or invalid playtime targets', () => {
    assert.equal(
      validateGameTaskParams('Roguelike', { theme: 'JieGarden', mode: 20001 }),
      'Roguelike.params.find_playTime_target 在 mode 20001 下必填'
    );
    assert.equal(
      validateGameTaskParams('Roguelike', { theme: 'JieGarden', mode: 20001, find_playTime_target: 4 }),
      'Roguelike.params.find_playTime_target 必须是 1、2 或 3'
    );
  });

  it('rejects invalid black-flow start-run parameters', () => {
    assert.equal(
      validateGameTaskParams('Roguelike', { theme: 'BlackFlow', mode: 30003 }),
      'Roguelike.params.blackflow_start_animals 在 mode 30003 下必填'
    );
    assert.equal(
      validateGameTaskParams('Roguelike', {
        theme: 'BlackFlow',
        mode: 30003,
        blackflow_start_animals: ['swaddled_cat', 'swaddled_dog', 'swaddled_cerberus'],
        blackflow_start_rewards: 0
      }),
      'Roguelike.params.blackflow_start_animals 最多包含两项'
    );
    assert.equal(
      validateGameTaskParams('Roguelike', {
        theme: 'BlackFlow',
        mode: 30003,
        blackflow_start_animals: ['swaddled_feathered_serpent', 'swaddled_feathered_serpent'],
        blackflow_start_rewards: 0
      }),
      'Roguelike.params.blackflow_start_animals 最多包含一项襁褓羽蛇'
    );
    assert.equal(
      validateGameTaskParams('Roguelike', {
        theme: 'BlackFlow',
        mode: 30003,
        blackflow_start_animals: ['unknown_animal'],
        blackflow_start_rewards: 0
      }),
      'Roguelike.params.blackflow_start_animals 含未知动物 unknown_animal，可选：swaddled_cat、swaddled_dog、swaddled_cerberus、swaddled_feathered_serpent'
    );
    assert.equal(
      validateGameTaskParams('Roguelike', {
        theme: 'BlackFlow',
        mode: 30003,
        blackflow_start_animals: [],
        blackflow_start_rewards: 4096
      }),
      'Roguelike.params.blackflow_start_rewards 必须是 0 至 4095 的整数'
    );
  });

  it('rejects utopia without a valid reward priority', () => {
    assert.equal(
      validateGameTaskParams('Roguelike', {
        theme: 'BlackFlow',
        mode: 30003,
        blackflow_start_animals: [],
        blackflow_start_rewards: 0,
        blackflow_start_utopia: true
      }),
      'Roguelike.params.blackflow_start_reward_priority 在 blackflow_start_utopia 启用时必须是奖励标识数组'
    );
    assert.equal(
      validateGameTaskParams('Roguelike', {
        theme: 'BlackFlow',
        mode: 30003,
        blackflow_start_animals: [],
        blackflow_start_rewards: 0,
        blackflow_start_utopia: true,
        blackflow_start_reward_priority: ['pegasus', 'pegasus']
      }),
      'Roguelike.params.blackflow_start_reward_priority 不能包含重复奖励 pegasus'
    );
  });

  it('rejects invalid elite-two combinations and unknown strategies', () => {
    assert.equal(
      validateGameTaskParams('Roguelike', { mode: 4, only_start_with_elite_two: true }),
      'Roguelike.params.only_start_with_elite_two 只能与 start_with_elite_two 同时使用'
    );
    assert.equal(
      validateGameTaskParams('Roguelike', { start_with_elite_two: true }),
      'Roguelike.params.start_with_elite_two 仅在 mode 4 下可用'
    );
    assert.equal(
      validateGameTaskParams('Roguelike', { blackflow_strategy: 'unknown' }),
      'Roguelike.params.blackflow_strategy 必须是 baby_animal、investment、burn_with_investment、burn、ending1、ending2、ending3 之一'
    );
  });
});

describe('validateGameTaskParams Reclamation', () => {
  it('accepts both themes and their modes', () => {
    for (const params of [
      {},
      { theme: 'Tales', mode: 0, clear_store: true },
      { theme: 'Tales', mode: 1, tools_to_craft: ['荧光棒'], increment_mode: 1, num_craft_batches: 2 },
      { theme: 'RelaunchAnchor', mode: 16 },
      { theme: 'RelaunchAnchor', mode: 32 },
      { theme: 'RelaunchAnchor', mode: 48 }
    ]) {
      assert.equal(validateGameTaskParams('Reclamation', params), null, JSON.stringify(params));
    }
  });

  it('rejects themes, modes and field values outside the protocol', () => {
    assert.equal(
      validateGameTaskParams('Reclamation', { theme: 'Fire' }),
      'Reclamation.params.theme 必须是 Tales、RelaunchAnchor 之一'
    );
    assert.equal(
      validateGameTaskParams('Reclamation', { theme: 'RelaunchAnchor' }),
      'Reclamation.params.mode 在 RelaunchAnchor 主题下必填，可选：16、32、48'
    );
    assert.equal(
      validateGameTaskParams('Reclamation', { theme: 'RelaunchAnchor', mode: 1 }),
      'Reclamation.params.mode 1 不适用于 RelaunchAnchor 主题，可选：16、32、48'
    );
    assert.equal(
      validateGameTaskParams('Reclamation', { theme: 'Tales', mode: 16 }),
      'Reclamation.params.mode 16 不适用于 Tales 主题，可选：0、1'
    );
    assert.equal(
      validateGameTaskParams('Reclamation', { mode: 0, increment_mode: 2 }),
      'Reclamation.params.increment_mode 必须是 0 或 1'
    );
    assert.equal(
      validateGameTaskParams('Reclamation', { mode: 1, num_craft_batches: 0 }),
      'Reclamation.params.num_craft_batches 必须是正整数'
    );
    assert.equal(
      validateGameTaskParams('Reclamation', { mode: 0, clear_store: 'yes' }),
      'Reclamation.params.clear_store 必须是布尔值'
    );
    assert.equal(
      validateGameTaskParams('Reclamation', { mode: 1, tools_to_craft: [''] }),
      'Reclamation.params.tools_to_craft 必须是非空工具名数组'
    );
  });
});

describe('validateRoguelikeCommandArgs', () => {
  it('ignores commands without roguelike arguments', () => {
    assert.equal(validateRoguelikeCommandArgs('fight', ['1-7']), null);
    assert.equal(validateRoguelikeCommandArgs('run', ['agent-award']), null);
  });

  it('leaves unknown leading options to maa-cli instead of guessing the theme', () => {
    assert.equal(validateRoguelikeCommandArgs('roguelike', ['--profile', 'custom', 'Sami']), null);
    assert.equal(validateRoguelikeCommandArgs('roguelike', ['--mode', '9', 'Sami']), '集成战略 --mode 必须是 0、1、4、5、6 或 7');
  });

  it('accepts arguments the installed maa-cli understands', () => {
    for (const [command, args] of [
      ['roguelike', ['Sami', '--mode', '5', '-P', '目空一些']],
      ['roguelike', ['Phantom', '--mode=4', '--starts-count', '3']],
      ['roguelike', ['Sarkaz', '--mode', '1', '--start-with-seed', '2b3c4d,rogue_1,120']],
      ['reclamation', ['Tales', '-m', '1', '-C', '荧光棒', '--increment-mode', '1']],
      ['reclamation', ['Tales']]
    ] as const) {
      assert.equal(validateRoguelikeCommandArgs(command, args), null, `${command} ${args.join(' ')}`);
    }
  });

  it('rejects Core-only themes and modes before they reach the CLI', () => {
    assert.equal(
      validateRoguelikeCommandArgs('roguelike', ['BlackFlow']),
      'maa-cli 0.7.8 不支持主题「BlackFlow」，请改用 command=run 加 taskConfig 动态任务'
    );
    assert.equal(
      validateRoguelikeCommandArgs('roguelike', ['Unknown']),
      '集成战略主题必须是 Phantom、Mizuki、Sami、Sarkaz、JieGarden 之一；「Unknown」请改用 command=run 加 taskConfig 动态任务'
    );
    assert.equal(
      validateRoguelikeCommandArgs('roguelike', ['Sarkaz', '--mode', '20001']),
      'maa-cli 0.7.8 不支持 --mode 20001，请改用 command=run 加 taskConfig 动态任务'
    );
    assert.equal(
      validateRoguelikeCommandArgs('reclamation', ['RelaunchAnchor', '--mode', '16']),
      'maa-cli 的生息演算只支持 Tales 主题；「RelaunchAnchor」请改用 command=run 加 taskConfig 动态任务'
    );
  });

  it('rejects values outside the CLI protocol', () => {
    assert.equal(validateRoguelikeCommandArgs('roguelike', ['Sami', '--mode', '9']), '集成战略 --mode 必须是 0、1、4、5、6 或 7');
    assert.equal(validateRoguelikeCommandArgs('roguelike', ['Sarkaz', '--mode', '5']), '集成战略模式 5 仅支持萨米（Sami）主题');
    assert.equal(validateRoguelikeCommandArgs('roguelike', ['Phantom', '--mode', 'abc']), '集成战略 --mode 必须是整数');
    assert.equal(validateRoguelikeCommandArgs('roguelike', ['Phantom', '--starts-count', '1.5']), '集成战略 --starts-count 必须是整数');
    assert.equal(validateRoguelikeCommandArgs('roguelike', ['Sami', '-F', '']), '集成战略 -F 不能为空白值');
    assert.equal(validateRoguelikeCommandArgs('reclamation', ['Tales', '-m', '2']), '生息演算 --mode 必须是 0 或 1');
    assert.equal(validateRoguelikeCommandArgs('reclamation', ['Tales', '--increment-mode', '3']), '生息演算 --increment-mode 必须是 0 或 1');
    assert.equal(validateRoguelikeCommandArgs('reclamation', ['Tales', '--num-craft-batches', '0']), '生息演算 --num-craft-batches 必须是正整数');
  });
});

describe('normalizeGameTaskParams', () => {
  it('migrates the legacy snake_case playtime target to the Core spelling', () => {
    const normalization = normalizeGameTaskParams('Roguelike', {
      theme: 'JieGarden',
      mode: 20001,
      find_play_time_target: 2
    });
    assert.deepEqual(normalization, {
      params: { theme: 'JieGarden', mode: 20001, find_playTime_target: 2 },
      error: null
    });
  });

  it('keeps the authoritative value and drops only a matching legacy duplicate', () => {
    const normalization = normalizeGameTaskParams('Roguelike', {
      find_play_time_target: 3,
      find_playTime_target: 3
    });
    assert.deepEqual(normalization, { params: { find_playTime_target: 3 }, error: null });
  });

  it('reports conflicting spellings instead of silently dropping one value', () => {
    assert.deepEqual(normalizeGameTaskParams('Roguelike', {
      find_play_time_target: 1,
      find_playTime_target: 2
    }), {
      params: { find_play_time_target: 1, find_playTime_target: 2 },
      error: 'Roguelike.params 同时包含 find_play_time_target 与 find_playTime_target 且取值不同'
    });
  });

  it('leaves other task types and canonical params untouched', () => {
    const fightParams = { stage: '1-7', times: 3 };
    const fight = normalizeGameTaskParams('Fight', fightParams);
    assert.equal(fight.params, fightParams);
    assert.equal(fight.error, null);

    const canonical = normalizeGameTaskParams('Roguelike', { find_playTime_target: 2 });
    assert.deepEqual(canonical, { params: { find_playTime_target: 2 }, error: null });
  });
});
