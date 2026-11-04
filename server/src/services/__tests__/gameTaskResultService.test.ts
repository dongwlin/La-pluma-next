import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseGameTaskExecutionAction, readOperProgressPlans } from '../gameTaskResultService.ts';
import type { GameTaskPlanTarget, GameTaskType } from '../gameTaskResultService.ts';

function callback(taskchain: GameTaskType, type: string, payload: Record<string, unknown>): string {
  return `Assistant::append_callback | ${type} ${JSON.stringify({ taskchain, ...payload })}`;
}

function progress(what: string, details: unknown): string {
  return callback('OperProgress', 'SubTaskExtraInfo', { what, details });
}

function themeTask(task: string, extra: Record<string, unknown> = {}): string {
  return callback('SwitchTheme', 'SubTaskCompleted', { details: { task, ...extra } });
}

describe('game task results', () => {
  it('preserves cultivation results and the actual mastery training that was started', () => {
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress', [
      progress('OperProgressDetail', {
        role: 'Warrior', name: '陈', result: 'Success', result_detail: 'AlreadySatisfied', elite: 2
      }),
      progress('OperProgressDetail', {
        role: 'Warrior', name: '陈', result: 'Success', result_detail: 'PrerequisiteTraining',
        skill_mastery: [0, 2, 0]
      }),
      progress('OperProgressSummary', {
        success: 2, failed: 0, skipped: 0,
        finished: [{ role: 'Warrior', name: '陈', elite: 2, skill_mastery: [0, 2, 0] }]
      })
    ].join('\n'));

    assert.equal(action.status, 'success');
    assert.equal(action.observed, true);
    assert.equal(action.successCount, 2);
    assert.equal(action.trainingStartedCount, 1);
    assert.deepEqual(action.details, [
      { name: '陈', role: 'Warrior', result: 'Success', resultDetail: 'AlreadySatisfied', elite: 2 },
      { name: '陈', role: 'Warrior', result: 'Success', resultDetail: 'PrerequisiteTraining', skillMastery: [0, 2, 0] }
    ]);
    assert.match(action.message, /训练仍需游戏内时间/);
  });

  it('does not turn failed cultivation items into success when the task chain completes', () => {
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress', [
      progress('OperProgressSummary', { success: 1, failed: 2, skipped: 3 }),
      callback('OperProgress', 'TaskChainCompleted', {})
    ].join('\n'));

    assert.equal(action.status, 'failed');
    assert.equal(action.failedCount, 2);
    assert.equal(action.skippedCount, 3);
    assert.match(action.message, /成功 1，失败 2，跳过 3/);
  });

  it('retains detail failures even if a later summary reports no failures', () => {
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress', [
      progress('OperProgressDetail', {
        role: 'Medic', name: '白面鸮', result: 'Failed', result_detail: 'ResourceInsufficient'
      }),
      progress('OperProgressSummary', { success: 1, failed: 0, skipped: 0 })
    ].join('\n'));

    assert.equal(action.status, 'failed');
    assert.equal(action.failedCount, 1);
    assert.equal(action.details?.[0]?.resultDetail, 'ResourceInsufficient');
  });

  it('reports an occupied training room as skipped', () => {
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress', [
      progress('OperProgressDetail', {
        name: '白面鸮', result: 'Skipped', result_detail: 'TrainingRoomBusy'
      }),
      progress('OperProgressSummary', { success: 0, failed: 0, skipped: 1 })
    ].join('\n'));

    assert.equal(action.status, 'skipped');
    assert.equal(action.skippedCount, 1);
    assert.equal(action.trainingStartedCount, 0);
  });

  it('reports an empty cultivation summary as skipped', () => {
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress',
      progress('OperProgressSummary', { success: 0, failed: 0, skipped: 0 }));

    assert.equal(action.status, 'skipped');
    assert.equal(action.observed, true);
  });

  it('reports a cultivation task chain error without inventing successful items', () => {
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress',
      callback('OperProgress', 'TaskChainError', {}));

    assert.equal(action.status, 'failed');
    assert.equal(action.successCount, 0);
    assert.equal(action.observed, true);
  });

  it('does not claim a complete cultivation result from detail callbacks alone', () => {
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress',
      progress('OperProgressDetail', {
        name: '白面鸮', result: 'Success', result_detail: 'Completed', skill_level: 7
      }));

    assert.equal(action.status, 'success');
    assert.equal(action.observed, false);
    assert.equal(action.successCount, 1);
    assert.equal(action.details?.[0]?.skillLevel, 7);
    assert.match(action.message, /完整结果未确认/);
  });

  it('does not count mastery that was already satisfied as newly started training', () => {
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress',
      progress('OperProgressDetail', {
        name: '陈', result: 'Success', result_detail: 'AlreadySatisfied', skill_mastery: [3, 0, 0]
      }));

    assert.equal(action.trainingStartedCount, 0);
  });

  it('ignores malformed counts, details, truncated lines and foreign task chains', () => {
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress', [
      progress('OperProgressSummary', { success: -1, failed: 0, skipped: 0 }),
      progress('OperProgressSummary', { success: 1, failed: '2', skipped: 0 }),
      progress('OperProgressDetail', { name: '陈', result: 'Failed' }),
      progress('OperProgressDetail', { name: '陈', result: {}, result_detail: 'Failed' }),
      progress('OperProgressDetail', { name: '陈', result: { toString: null }, result_detail: 'Failed' }),
      progress('OperProgressDetail', []),
      callback('SwitchTheme', 'SubTaskExtraInfo', {
        what: 'OperProgressSummary', details: { success: 0, failed: 2, skipped: 0 }
      }),
      'Assistant::append_callback | SubTaskExtraInfo {"taskchain":"OperProgress","details":'
    ].join('\n'));

    assert.equal(action.observed, false);
    assert.equal(action.successCount, undefined);
    assert.equal(action.failedCount, undefined);
    assert.match(action.message, /游戏结果未确认/);
  });

  it('only interprets cultivation payloads from extra-info events', () => {
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress',
      callback('OperProgress', 'SubTaskStart', {
        what: 'OperProgressSummary', details: { success: 0, failed: 2, skipped: 0 }
      }));

    assert.equal(action.observed, false);
  });

  it('reports the confirmed game theme', () => {
    const action = parseGameTaskExecutionAction('主题更换', 'SwitchTheme', [
      themeTask('SwitchThemeByNameSelectTheme', { result: { text: '白云' } }),
      themeTask('SwitchThemeByNameConfirmTheme')
    ].join('\n'));

    assert.equal(action.status, 'success');
    assert.equal(action.observed, true);
    assert.equal(action.theme, '白云');
    assert.match(action.message, /白云.*已更换/);
  });

  it('distinguishes an already selected theme from a new switch', () => {
    const action = parseGameTaskExecutionAction('主题更换', 'SwitchTheme',
      themeTask('SwitchThemeByNameAlreadySet'));

    assert.equal(action.status, 'success');
    assert.match(action.message, /已是当前主题/);
  });

  it('reports empty theme candidates as skipped', () => {
    const action = parseGameTaskExecutionAction('主题更换', 'SwitchTheme',
      callback('SwitchTheme', 'SubTaskExtraInfo', { what: 'SwitchThemeSkipped' }));

    assert.equal(action.status, 'skipped');
    assert.equal(action.observed, true);
  });

  it('reports a missing game theme as failed', () => {
    const action = parseGameTaskExecutionAction('主题更换', 'SwitchTheme',
      callback('SwitchTheme', 'SubTaskExtraInfo', {
        what: 'SwitchThemeNotFound', details: { theme: '未拥有的主题' }
      }));

    assert.equal(action.status, 'failed');
    assert.equal(action.theme, '未拥有的主题');
    assert.match(action.message, /未找到/);
  });

  it('does not call a locked theme successful when the task chain completes', () => {
    const action = parseGameTaskExecutionAction('主题更换', 'SwitchTheme', [
      themeTask('SwitchThemeByNameLockedTheme'),
      callback('SwitchTheme', 'TaskChainCompleted', {})
    ].join('\n'));

    assert.equal(action.status, 'failed');
    assert.match(action.message, /尚未解锁，未更换/);
  });

  it('lets a theme task-chain error take precedence over an earlier confirmation', () => {
    const action = parseGameTaskExecutionAction('主题更换', 'SwitchTheme', [
      themeTask('SwitchThemeByNameConfirmTheme'),
      callback('SwitchTheme', 'TaskChainError', {})
    ].join('\n'));

    assert.equal(action.status, 'failed');
  });

  it('does not infer a theme switch from a started action or foreign callback', () => {
    const action = parseGameTaskExecutionAction('主题更换', 'SwitchTheme', [
      callback('SwitchTheme', 'SubTaskStart', { details: { task: 'SwitchThemeByNameConfirmTheme' } }),
      callback('OperProgress', 'SubTaskCompleted', { details: { task: 'SwitchThemeByNameConfirmTheme' } }),
      'Assistant::append_callback | SubTaskCompleted {"taskchain":"SwitchTheme",'
    ].join('\n'));

    assert.equal(action.observed, false);
    assert.match(action.message, /游戏结果未确认/);
  });

  it('keeps process-only fallback explicit when logs are unavailable', () => {
    for (const taskType of ['OperProgress', 'SwitchTheme'] as const) {
      const action = parseGameTaskExecutionAction('任务', taskType, null);
      assert.equal(action.observed, false);
      assert.match(action.message, /进程已完成，游戏结果未确认/);
    }
  });

  it('reads oper progress plans and skips malformed entries', () => {
    assert.deepEqual(readOperProgressPlans({
      plans: [
        { name: '陈', role: 'Warrior', elite: 2, skill_level: 7, skill_mastery: [0, 2, 0] },
        null,
        { name: '' },
        { name: '   ' },
        { role: 'Caster' },
        { name: '阿米娅', skill_mastery: [1, 0] }
      ]
    }), [
      { name: '陈', role: 'Warrior', elite: 2, skillLevel: 7, skillMastery: [0, 2, 0] },
      { name: '阿米娅' }
    ]);
    assert.deepEqual(readOperProgressPlans({}), []);
  });

  it('reports mastery targets that a later run must train after one training starts', () => {
    const plans: GameTaskPlanTarget[] = [
      { name: '陈', role: 'Warrior', skillMastery: [0, 2, 0] },
      { name: '阿米娅', role: 'Caster', skillMastery: [1, 0, 0] }
    ];
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress', [
      progress('OperProgressDetail', {
        role: 'Warrior', name: '陈', result: 'Success', result_detail: 'PrerequisiteTraining',
        skill_mastery: [0, 1, 0]
      }),
      progress('OperProgressSummary', { success: 1, failed: 0, skipped: 0 })
    ].join('\n'), plans);

    assert.equal(action.status, 'success');
    assert.equal(action.successCount, 1);
    assert.equal(action.failedCount, 0);
    assert.equal(action.skippedCount, 0);
    assert.equal(action.deferredCount, 1);
    assert.deepEqual(action.deferredMastery, [
      { name: '阿米娅', role: 'Caster', skillMastery: [1, 0, 0] }
    ]);
    assert.match(action.message, /1 项专精目标本轮未执行，需后续运行/);
  });

  it('defers mastery of a later plan even when its elite goal was reported', () => {
    const plans: GameTaskPlanTarget[] = [
      { name: '陈', role: 'Warrior', skillMastery: [0, 0, 1] },
      { name: '能天使', role: 'Sniper', elite: 2, skillLevel: 7, skillMastery: [2, 0, 0] }
    ];
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress', [
      progress('OperProgressDetail', {
        role: 'Warrior', name: '陈', result: 'Success', result_detail: 'Completed',
        skill_mastery: [0, 0, 1]
      }),
      progress('OperProgressDetail', {
        role: 'Sniper', name: '能天使', result: 'Success', result_detail: 'Completed', elite: 2
      }),
      progress('OperProgressSummary', { success: 2, failed: 0, skipped: 0 })
    ].join('\n'), plans);

    assert.equal(action.status, 'success');
    assert.equal(action.deferredCount, 1);
    assert.deepEqual(action.deferredMastery, [
      { name: '能天使', role: 'Sniper', skillMastery: [2, 0, 0] }
    ]);
    assert.match(action.message, /1 项专精目标本轮未执行/);
  });

  it('defers remaining mastery slots of the same plan', () => {
    const plans: GameTaskPlanTarget[] = [
      { name: '陈', role: 'Warrior', skillMastery: [1, 2, 0] }
    ];
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress', [
      progress('OperProgressDetail', {
        role: 'Warrior', name: '陈', result: 'Success', result_detail: 'Completed',
        skill_mastery: [1, 0, 0]
      }),
      progress('OperProgressSummary', { success: 1, failed: 0, skipped: 0 })
    ].join('\n'), plans);

    assert.equal(action.status, 'success');
    assert.equal(action.deferredCount, 1);
    assert.deepEqual(action.deferredMastery, [
      { name: '陈', role: 'Warrior', skillMastery: [0, 2, 0] }
    ]);
    assert.match(action.message, /1 项专精目标本轮未执行/);
  });

  it('does not defer mastery slots when no training was started', () => {
    const plans: GameTaskPlanTarget[] = [
      { name: '陈', role: 'Warrior', skillMastery: [3, 0, 0] }
    ];
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress', [
      progress('OperProgressDetail', {
        role: 'Warrior', name: '陈', result: 'Success', result_detail: 'AlreadySatisfied',
        skill_mastery: [3, 0, 0]
      }),
      progress('OperProgressSummary', { success: 1, failed: 0, skipped: 0 })
    ].join('\n'), plans);

    assert.equal(action.status, 'success');
    assert.equal(action.deferredCount, undefined);
    assert.equal(action.deferredMastery, undefined);
    assert.doesNotMatch(action.message, /未执行/);
  });

  it('keeps previous behavior when no plans are supplied', () => {
    const logOutput = [
      progress('OperProgressDetail', {
        role: 'Warrior', name: '陈', result: 'Success', result_detail: 'PrerequisiteTraining',
        skill_mastery: [0, 2, 0]
      }),
      progress('OperProgressSummary', { success: 1, failed: 0, skipped: 0 })
    ].join('\n');
    const withoutPlans = parseGameTaskExecutionAction('游戏内培养', 'OperProgress', logOutput);
    const withEmptyPlans = parseGameTaskExecutionAction('游戏内培养', 'OperProgress', logOutput, []);

    assert.deepEqual(withEmptyPlans, withoutPlans);
    assert.equal(withoutPlans.deferredCount, undefined);
    assert.equal(withoutPlans.deferredMastery, undefined);
    assert.doesNotMatch(withoutPlans.message, /未执行/);
  });

  it('defers later mastery plans after a busy training room without inflating skipped count', () => {
    const plans: GameTaskPlanTarget[] = [
      { name: '陈', role: 'Warrior', skillMastery: [1, 0, 0] },
      { name: '阿米娅', role: 'Caster', skillMastery: [0, 2, 0] }
    ];
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress', [
      progress('OperProgressDetail', {
        role: 'Warrior', name: '陈', result: 'Skipped', result_detail: 'TrainingRoomBusy'
      }),
      progress('OperProgressSummary', { success: 0, failed: 0, skipped: 1 })
    ].join('\n'), plans);

    assert.equal(action.status, 'skipped');
    assert.equal(action.skippedCount, 1);
    assert.equal(action.deferredCount, 1);
    assert.deepEqual(action.deferredMastery, [
      { name: '阿米娅', role: 'Caster', skillMastery: [0, 2, 0] }
    ]);
    assert.match(action.message, /1 项专精目标本轮未执行，需后续运行/);
  });

  it('defers a later plan of the same operator when only the first mastery training starts', () => {
    const plans: GameTaskPlanTarget[] = [
      { name: '阿米娅', role: 'Caster', skillMastery: [1, 0, 0] },
      { name: '阿米娅', role: 'Caster', skillMastery: [0, 2, 0] }
    ];
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress', [
      progress('OperProgressDetail', {
        role: 'Caster', name: '阿米娅', result: 'Success', result_detail: 'Completed',
        skill_mastery: [1, 0, 0]
      }),
      progress('OperProgressSummary', { success: 1, failed: 0, skipped: 0 })
    ].join('\n'), plans);

    assert.equal(action.status, 'success');
    assert.equal(action.successCount, 1);
    assert.equal(action.skippedCount, 0);
    assert.equal(action.deferredCount, 1);
    assert.deepEqual(action.deferredMastery, [
      { name: '阿米娅', role: 'Caster', skillMastery: [0, 2, 0] }
    ]);
    assert.match(action.message, /1 项专精目标本轮未执行，需后续运行/);
  });

  it('defers a later plan of the same operator targeting the same skill slot', () => {
    const plans: GameTaskPlanTarget[] = [
      { name: '阿米娅', role: 'Caster', skillMastery: [1, 0, 0] },
      { name: '阿米娅', role: 'Caster', skillMastery: [2, 0, 0] }
    ];
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress', [
      progress('OperProgressDetail', {
        role: 'Caster', name: '阿米娅', result: 'Success', result_detail: 'Completed',
        skill_mastery: [1, 0, 0]
      }),
      progress('OperProgressSummary', { success: 1, failed: 0, skipped: 0 })
    ].join('\n'), plans);

    assert.equal(action.status, 'success');
    assert.equal(action.skippedCount, 0);
    assert.equal(action.deferredCount, 1);
    assert.deepEqual(action.deferredMastery, [
      { name: '阿米娅', role: 'Caster', skillMastery: [2, 0, 0] }
    ]);
  });

  it('attributes the trigger to the plan whose mastery detail was reported', () => {
    const plans: GameTaskPlanTarget[] = [
      { name: '阿米娅', role: 'Caster', skillMastery: [3, 0, 0] },
      { name: '阿米娅', role: 'Caster', skillMastery: [2, 0, 0] },
      { name: '陈', role: 'Warrior', skillMastery: [0, 2, 0] }
    ];
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress', [
      progress('OperProgressDetail', {
        role: 'Caster', name: '阿米娅', result: 'Success', result_detail: 'AlreadySatisfied',
        skill_mastery: [3, 0, 0]
      }),
      progress('OperProgressDetail', {
        role: 'Caster', name: '阿米娅', result: 'Success', result_detail: 'Completed',
        skill_mastery: [2, 0, 0]
      }),
      progress('OperProgressSummary', { success: 2, failed: 0, skipped: 0 })
    ].join('\n'), plans);

    assert.equal(action.status, 'success');
    assert.equal(action.deferredCount, 1);
    assert.deepEqual(action.deferredMastery, [
      { name: '陈', role: 'Warrior', skillMastery: [0, 2, 0] }
    ]);
  });

  it('keeps the trigger on a plan that reported several mastery details', () => {
    const plans: GameTaskPlanTarget[] = [
      { name: '陈', role: 'Warrior', skillMastery: [3, 1, 0] },
      { name: '陈', role: 'Warrior', skillMastery: [2, 0, 0] }
    ];
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress', [
      progress('OperProgressDetail', {
        role: 'Warrior', name: '陈', result: 'Success', result_detail: 'AlreadySatisfied',
        skill_mastery: [3, 0, 0]
      }),
      progress('OperProgressDetail', {
        role: 'Warrior', name: '陈', result: 'Success', result_detail: 'Completed',
        skill_mastery: [0, 1, 0]
      }),
      progress('OperProgressSummary', { success: 2, failed: 0, skipped: 0 })
    ].join('\n'), plans);

    assert.equal(action.status, 'success');
    assert.equal(action.deferredCount, 1);
    assert.deepEqual(action.deferredMastery, [
      { name: '陈', role: 'Warrior', skillMastery: [2, 0, 0] }
    ]);
  });

  it('defers remaining mastery slots after a busy room for a repeated operator', () => {
    const plans: GameTaskPlanTarget[] = [
      { name: '阿米娅', role: 'Caster', skillMastery: [1, 0, 0] },
      { name: '阿米娅', role: 'Caster', skillMastery: [2, 1, 0] }
    ];
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress', [
      progress('OperProgressDetail', {
        role: 'Caster', name: '阿米娅', result: 'Success', result_detail: 'AlreadySatisfied',
        skill_mastery: [1, 0, 0]
      }),
      progress('OperProgressDetail', {
        role: 'Caster', name: '阿米娅', result: 'Skipped', result_detail: 'TrainingRoomBusy'
      }),
      progress('OperProgressSummary', { success: 1, failed: 0, skipped: 1 })
    ].join('\n'), plans);

    assert.equal(action.status, 'success');
    assert.equal(action.skippedCount, 1);
    assert.equal(action.deferredCount, 1);
    assert.deepEqual(action.deferredMastery, [
      { name: '阿米娅', role: 'Caster', skillMastery: [0, 1, 0] }
    ]);
  });

  it('does not defer a mastery slot already reported as failed before a busy room', () => {
    const plans: GameTaskPlanTarget[] = [
      { name: '陈', role: 'Warrior', skillMastery: [2, 1, 0] }
    ];
    const action = parseGameTaskExecutionAction('游戏内培养', 'OperProgress', [
      progress('OperProgressDetail', {
        role: 'Warrior', name: '陈', result: 'Failed', result_detail: 'RecognitionFailed'
      }),
      progress('OperProgressDetail', {
        role: 'Warrior', name: '陈', result: 'Skipped', result_detail: 'TrainingRoomBusy'
      }),
      progress('OperProgressSummary', { success: 0, failed: 1, skipped: 1 })
    ].join('\n'), plans);

    assert.equal(action.status, 'failed');
    assert.equal(action.failedCount, 1);
    assert.equal(action.skippedCount, 1);
    assert.equal(action.deferredCount, undefined);
    assert.equal(action.deferredMastery, undefined);
    assert.doesNotMatch(action.message, /未执行/);
  });
});
