import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGENT_TASK_COMMANDS,
  createDailyFlowExecutionError,
  executeAgentTask,
  normalizeCopilotSetExecutionRequest,
  normalizeCopilotSetMode,
  normalizeDailyFlowRequest,
  preflightAgentTaskRequest
} from '../agentActionService.ts';

type ExecutorCall = Record<string, unknown>;

function createExecutors() {
  const calls: ExecutorCall[] = [];
  return {
    calls,
    dependencies: {
      execMaaCommand: async (...args: unknown[]) => {
        calls.push({ executor: 'command', args });
        return { success: true, executor: 'command' };
      },
      execDynamicTask: async (...args: unknown[]) => {
        calls.push({ executor: 'dynamic', args });
        return { success: true, executor: 'dynamic' };
      },
      execDynamicTasks: async (...args: unknown[]) => {
        calls.push({ executor: 'dynamic-batch', args });
        return { success: true, executor: 'dynamic-batch' };
      }
    }
  };
}

function errorField(error: unknown, key: string): unknown {
  return typeof error === 'object' && error !== null && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

function detailsOf(error: unknown): Record<string, unknown> {
  const details = errorField(error, 'details');
  return typeof details === 'object' && details !== null ? details as Record<string, unknown> : {};
}

function resultOf(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null, 'expected object result');
  return value as Record<string, unknown>;
}

describe('executeAgentTask', () => {
  it('preserves nested game task plans and theme candidates on the dynamic path', async () => {
    const { calls, dependencies } = createExecutors();
    const configs = [
      { name: '游戏内培养', type: 'OperProgress', params: { plans: [{ name: '陈', role: 'Warrior', elite: 2, skill_mastery: [0, 3, 0] }] } },
      { name: '游戏界面主题', type: 'SwitchTheme', params: { themes: ['默认', '简约'] } }
    ];
    for (const taskConfig of configs) {
      await executeAgentTask({ command: 'run', taskConfig }, dependencies);
    }
    assert.deepEqual(calls.map(call => (call.args as unknown[])[1]), configs);
  });

  it('allows Core to infer an omitted or Unknown profession', async () => {
    const { calls, dependencies } = createExecutors();
    for (const plan of [{ name: '陈', elite: 2 }, { name: '陈', role: 'Unknown', elite: 2 }]) {
      const taskConfig = { name: '游戏内培养', type: 'OperProgress', params: { plans: [plan] } };
      await executeAgentTask({ command: 'run', taskConfig }, dependencies);
      assert.deepEqual((calls.at(-1)?.args as unknown[])[1], taskConfig);
    }
  });

  it('rejects malformed game targets before invoking either executor', async () => {
    const { calls, dependencies } = createExecutors();
    const invalidConfigs = [
      { name: '培养', type: 'OperProgress', params: { plans: [{ name: '陈', elite: 0 }] } },
      { name: '培养', type: 'OperProgress', params: { plans: [{ name: '陈', skill_level: 8 }] } },
      { name: '培养', type: 'OperProgress', params: { plans: [{ name: '陈', skill_mastery: [3] }] } },
      { name: '培养', type: 'OperProgress', params: { plans: [{ name: '陈', skill_level: '7' }] } },
      { name: '培养', type: 'OperProgress', params: { plans: [{ name: ' ', elite: 2 }] } },
      { name: '主题', type: 'SwitchTheme', params: { themes: '默认' } },
      { name: '主题', type: 'SwitchTheme', params: { themes: [false] } }
    ];
    for (const taskConfig of invalidConfigs) {
      await assert.rejects(
        executeAgentTask({ command: 'run', taskConfig }, dependencies),
        error => errorField(error, 'code') === 'AGENT_VALIDATION_TASK_CONFIG_INVALID'
      );
    }
    assert.deepEqual(calls, []);
  });

  it('executes a dynamic task with normalized config and all metadata', async () => {
    const { calls, dependencies } = createExecutors();

    const result = await executeAgentTask({
      command: 'run',
      args: ['custom-task'],
      taskConfig: JSON.stringify({ name: '自定义作战', type: 'Fight', params: { stage: '1-7' } }),
      taskName: '自定义作战',
      taskType: 'automation',
      waitForCompletion: false,
      userResource: true
    }, dependencies);

    assert.equal(resultOf(result).executor, 'dynamic');
    assert.deepEqual(calls, [{
      executor: 'dynamic',
      args: [
        'custom-task',
        { name: '自定义作战', type: 'Fight', params: { stage: '1-7' } },
        '自定义作战',
        'automation',
        false,
        true
      ]
    }]);
  });

  it('runs a Core-only task through the dynamic path with an explicit task id', async () => {
    const { calls, dependencies } = createExecutors();

    await executeAgentTask(
      { command: 'run', args: ['depot'], taskConfig: { name: '仓库识别', type: 'Depot' } },
      dependencies
    );

    assert.deepEqual(calls[0], {
      executor: 'dynamic',
      args: ['depot', { name: '仓库识别', type: 'Depot', params: {} }, 'Agent: run', 'agent', true, false]
    });
  });

  it('falls back to the command as the dynamic task id when no argument is given', async () => {
    const { calls, dependencies } = createExecutors();

    await executeAgentTask({ command: 'run', taskConfig: { name: '仓库识别', type: 'Depot' } }, dependencies);

    assert.deepEqual(calls[0], {
      executor: 'dynamic',
      args: ['run', { name: '仓库识别', type: 'Depot', params: {} }, 'Agent: run', 'agent', true, false]
    });
  });

  it('executes a tasks array through the batch executor in order', async () => {
    const { calls, dependencies } = createExecutors();
    const tasks = [
      { name: '领取奖励', type: 'Award', params: { award: true } },
      {
        name: '基建换班',
        type: 'Infrast',
        params: { mode: 10000 },
        strategy: 'merge',
        variants: [
          { condition: { type: 'Time', start: '18:00:00' }, params: { plan_index: 0 } },
          { params: { plan_index: 1 } }
        ]
      }
    ];

    const result = await executeAgentTask({
      command: 'run',
      args: ['multi-task'],
      taskConfig: { tasks },
      taskName: '多任务',
      taskType: 'automation',
      waitForCompletion: false
    }, dependencies);

    assert.equal(resultOf(result).executor, 'dynamic-batch');
    assert.deepEqual(calls, [{
      executor: 'dynamic-batch',
      args: [
        'multi-task',
        [
          { name: '领取奖励', type: 'Award', params: { award: true } },
          {
            name: '基建换班',
            type: 'Infrast',
            params: { mode: 10000 },
            strategy: 'merge',
            variants: [
              { condition: { type: 'Time', start: '18:00:00' }, params: { plan_index: 0 } },
              { params: { plan_index: 1 } }
            ]
          }
        ],
        '多任务',
        'automation',
        false,
        false
      ]
    }]);
  });

  it('executes a regular task with string args and caller metadata', async () => {
    const { calls, dependencies } = createExecutors();

    await executeAgentTask({
      command: 'fight',
      args: ['1-7', 3],
      taskName: '刷固源岩',
      taskType: 'combat',
      waitForCompletion: false
    }, dependencies);

    assert.deepEqual(calls[0], {
      executor: 'command',
      args: ['fight', ['1-7', '3'], '刷固源岩', 'combat', false]
    });
  });

  it('allows the list command', async () => {
    const { calls, dependencies } = createExecutors();

    await executeAgentTask({ command: 'list' }, dependencies);

    assert.ok(AGENT_TASK_COMMANDS.includes('list'));
    assert.deepEqual(calls[0], {
      executor: 'command',
      args: ['list', [], null, null, true]
    });
  });

  it('runs the reclamation CLI task with its own arguments', async () => {
    const { calls, dependencies } = createExecutors();

    await executeAgentTask({
      command: 'reclamation',
      args: ['Tales', '-m', '1'],
      taskName: '生息演算',
      taskType: 'roguelike',
      waitForCompletion: false
    }, dependencies);

    assert.deepEqual(calls[0], {
      executor: 'command',
      args: ['reclamation', ['Tales', '-m', '1'], '生息演算', 'roguelike', false]
    });
  });

  it('rejects roguelike arguments the installed maa-cli cannot express', async () => {
    const { calls, dependencies } = createExecutors();

    for (const request of [
      { command: 'roguelike', args: ['BlackFlow'] },
      { command: 'roguelike', args: ['Sarkaz', '--mode', '20001'] },
      { command: 'reclamation', args: ['RelaunchAnchor', '--mode', '16'] }
    ]) {
      await assert.rejects(
        executeAgentTask(request, dependencies),
        error => errorField(error, 'code') === 'AGENT_VALIDATION_TASK_ARGS_INVALID'
      );
    }
    assert.deepEqual(calls, []);
  });

  it('rejects Roguelike dynamic task configs with invalid parameter combinations', async () => {
    const { calls, dependencies } = createExecutors();

    await assert.rejects(
      executeAgentTask({
        command: 'run',
        args: ['roguelike'],
        taskConfig: {
          name: '集成战略',
          type: 'Roguelike',
          params: { theme: 'BlackFlow', mode: 30003 }
        }
      }, dependencies),
      error => errorField(error, 'code') === 'AGENT_VALIDATION_TASK_CONFIG_INVALID'
    );
    assert.deepEqual(calls, []);
  });

  it('migrates legacy snake_case roguelike params before running a dynamic task', async () => {
    const { calls, dependencies } = createExecutors();
    const taskConfig = {
      name: '集成战略',
      type: 'Roguelike',
      params: { theme: 'JieGarden', mode: 20001, find_play_time_target: 2 }
    };

    const request = preflightAgentTaskRequest({ command: 'run', args: ['roguelike'], taskConfig });
    assert.deepEqual(request.taskConfig?.params, {
      theme: 'JieGarden',
      mode: 20001,
      find_playTime_target: 2
    });

    await executeAgentTask({ command: 'run', args: ['roguelike'], taskConfig }, dependencies);
    const call = calls[0];
    assert.ok(call);
    const args = call.args as unknown[];
    const executed = args[1] as { params: Record<string, unknown> };
    assert.deepEqual(executed.params, {
      theme: 'JieGarden',
      mode: 20001,
      find_playTime_target: 2
    });
  });

  it('migrates legacy roguelike params inside task variants', () => {
    const request = preflightAgentTaskRequest({
      command: 'run',
      args: ['roguelike'],
      taskConfig: {
        name: '集成战略',
        type: 'Roguelike',
        params: { theme: 'JieGarden', mode: 20001, find_playTime_target: 2 },
        variants: [{ params: { find_play_time_target: 3 } }]
      }
    });

    assert.deepEqual(request.taskConfig?.variants, [{ params: { find_playTime_target: 3 } }]);
  });

  it('rejects conflicting legacy and authoritative roguelike params', async () => {
    await assert.rejects(
      executeAgentTask({
        command: 'run',
        args: ['roguelike'],
        taskConfig: {
          name: '集成战略',
          type: 'Roguelike',
          params: {
            theme: 'JieGarden',
            mode: 20001,
            find_play_time_target: 1,
            find_playTime_target: 2
          }
        }
      }, createExecutors().dependencies),
      error => errorField(error, 'code') === 'AGENT_VALIDATION_TASK_CONFIG_INVALID'
    );
  });

  it('keeps Core-only task types off the maa-cli command allowlist', async () => {
    const { calls, dependencies } = createExecutors();

    for (const command of ['infrast', 'recruit', 'mall', 'award', 'depot', 'operbox']) {
      await assert.rejects(
        executeAgentTask({ command }, dependencies),
        error => errorField(error, 'code') === 'AGENT_VALIDATION_COMMAND_NOT_ALLOWED'
      );
    }
    assert.deepEqual(calls, []);
  });

  it('runs read-only activity queries without overwriting tracked task state', async () => {
    const { calls, dependencies } = createExecutors();

    await executeAgentTask({
      command: 'activity',
      taskName: '不应进入状态栏',
      taskType: 'agent',
      waitForCompletion: false
    }, dependencies);

    assert.deepEqual(calls[0], {
      executor: 'command',
      args: ['activity', [], null, null, true]
    });
  });

  it('rejects commands outside the allowlist', async () => {
    const { dependencies } = createExecutors();

    await assert.rejects(
      executeAgentTask({ command: 'install' }, dependencies),
      error => {
        assert.equal(errorField(error, 'code'), 'AGENT_VALIDATION_COMMAND_NOT_ALLOWED');
        assert.equal(errorField(error, 'statusCode'), 400);
        assert.equal(errorField(error, 'retryable'), false);
        assert.equal(detailsOf(error).command, 'install');
        assert.deepEqual(detailsOf(error).allowed, [...AGENT_TASK_COMMANDS]);
        return true;
      }
    );
  });

  it('rejects malformed and non-object task configs', async () => {
    const { dependencies } = createExecutors();

    for (const taskConfig of ['{bad json', '[]', 'null', 42, {}, { name: '任务', type: 'Fight', params: [] }]) {
      await assert.rejects(
        executeAgentTask({ command: 'run', taskConfig }, dependencies),
        error => errorField(error, 'code') === 'AGENT_VALIDATION_TASK_CONFIG_INVALID' && errorField(error, 'statusCode') === 400
      );
    }
  });

  it('rejects dynamic task ids that could escape the task directory', async () => {
    const { dependencies } = createExecutors();

    await assert.rejects(
      executeAgentTask({
        command: 'run',
        args: ['../outside'],
        taskConfig: { name: '理智作战', type: 'Fight' }
      }, dependencies),
      error => {
        assert.equal(errorField(error, 'code'), 'AGENT_VALIDATION_TASK_ID_INVALID');
        assert.equal(errorField(error, 'statusCode'), 400);
        assert.equal(detailsOf(error).taskId, '../outside');
        return true;
      }
    );
  });

  it('rejects non-array args instead of silently discarding them', async () => {
    const { dependencies } = createExecutors();

    await assert.rejects(
      executeAgentTask({ command: 'fight', args: '1-7' }, dependencies),
      error => {
        assert.equal(errorField(error, 'code'), 'AGENT_VALIDATION_ARGS_INVALID');
        assert.equal(errorField(error, 'statusCode'), 400);
        assert.deepEqual(detailsOf(error), { receivedType: 'string' });
        return true;
      }
    );
  });

  it('rejects task metadata and execution flags with the wrong types', async () => {
    const { dependencies } = createExecutors();

    await assert.rejects(
      executeAgentTask({ command: 'startup', taskName: { text: '启动游戏' } }, dependencies),
      error => errorField(error, 'code') === 'AGENT_VALIDATION_TASK_NAME_INVALID'
    );
    await assert.rejects(
      executeAgentTask({ command: 'startup', waitForCompletion: 'false' }, dependencies),
      error => errorField(error, 'code') === 'AGENT_VALIDATION_WAIT_FOR_COMPLETION_INVALID'
    );
    await assert.rejects(
      executeAgentTask({ command: 'run', taskConfig: {}, userResource: 1 }, dependencies),
      error => errorField(error, 'code') === 'AGENT_VALIDATION_USER_RESOURCE_INVALID'
    );
  });
});

describe('preflightAgentTaskRequest', () => {
  it('rejects invalid task types before any execution', () => {
    const invalidInputs = [
      { command: 'run', taskConfig: { name: '任务', type: 42 } },
      { command: 'run', taskConfig: { name: '任务', type: 'Bad Type' } }
    ];
    for (const input of invalidInputs) {
      assert.throws(
        () => preflightAgentTaskRequest(input),
        error => ['AGENT_VALIDATION_TASK_CONFIG_INVALID', 'AGENT_VALIDATION_TASK_TYPE_INVALID']
          .includes(String(errorField(error, 'code')))
      );
    }
  });

  it('rejects invalid command combinations before run creation', () => {
    const invalidInputs = [
      { command: 'fight', taskConfig: { name: '任务', type: 'Award' } },
      { command: 'list', taskConfig: { name: '任务', type: 'Award' } },
      { command: 'run', userResource: true }
    ];
    for (const input of invalidInputs) {
      assert.throws(
        () => preflightAgentTaskRequest(input),
        error => {
          assert.equal(errorField(error, 'code'), 'AGENT_VALIDATION_COMMAND_COMBINATION_INVALID');
          assert.equal(errorField(error, 'statusCode'), 400);
          assert.equal(errorField(error, 'retryable'), false);
          return true;
        }
      );
    }
  });

  it('keeps OperProgress and SwitchTheme valid and normalizes legal requests', () => {
    const progress = preflightAgentTaskRequest({
      command: 'run',
      taskConfig: {
        name: '游戏内培养',
        type: 'OperProgress',
        params: { plans: [{ name: '陈', role: 'Unknown', elite: 2, skill_mastery: [0, 3, 0] }] }
      },
      taskName: ' 培养 ',
      waitForCompletion: false
    });
    assert.equal(progress.command, 'run');
    assert.equal(progress.taskName, '培养');
    assert.equal(progress.waitForCompletion, false);
    assert.deepEqual(progress.taskConfig, {
      name: '游戏内培养',
      type: 'OperProgress',
      params: { plans: [{ name: '陈', role: 'Unknown', elite: 2, skill_mastery: [0, 3, 0] }] }
    });

    const theme = preflightAgentTaskRequest({
      command: 'run',
      taskConfig: { name: '游戏界面主题', type: 'SwitchTheme', params: { themes: ['默认', '简约'] } }
    });
    assert.deepEqual(theme.taskConfig, {
      name: '游戏界面主题',
      type: 'SwitchTheme',
      params: { themes: ['默认', '简约'] }
    });
  });

  it('normalizes a legacy single task with strategy and nested variants', () => {
    const request = preflightAgentTaskRequest({
      command: 'run',
      taskConfig: {
        name: ' 基建换班 ',
        type: 'Infrast',
        params: { mode: 10000 },
        strategy: 'merge',
        variants: [
          { condition: { type: 'Time', start: '18:00:00' }, params: { plan_index: 0 } },
          { params: { plan_index: 1 } }
        ]
      }
    });

    assert.equal(request.taskConfigs, undefined);
    assert.deepEqual(request.taskConfig, {
      name: '基建换班',
      type: 'Infrast',
      params: { mode: 10000 },
      strategy: 'merge',
      variants: [
        { condition: { type: 'Time', start: '18:00:00' }, params: { plan_index: 0 } },
        { params: { plan_index: 1 } }
      ]
    });
  });

  it('normalizes a tasks array into ordered task configs', () => {
    const request = preflightAgentTaskRequest({
      command: 'run',
      args: ['multi-task'],
      taskConfig: {
        tasks: [
          { name: ' 领取奖励 ', type: 'Award' },
          {
            name: '基建换班',
            type: 'Infrast',
            params: { mode: 10000 },
            strategy: 'first',
            variants: [{ params: { plan_index: 0 } }]
          }
        ]
      }
    });

    assert.equal(request.taskConfig, undefined);
    assert.deepEqual(request.taskConfigs, [
      { name: '领取奖励', type: 'Award', params: {} },
      {
        name: '基建换班',
        type: 'Infrast',
        params: { mode: 10000 },
        strategy: 'first',
        variants: [{ params: { plan_index: 0 } }]
      }
    ]);

    const encoded = preflightAgentTaskRequest({
      command: 'run',
      taskConfig: JSON.stringify({ tasks: [{ name: ' 奖励 ', type: 'Award' }] })
    });
    assert.deepEqual(encoded.taskConfigs, [{ name: '奖励', type: 'Award', params: {} }]);
  });

  it('rejects malformed batch and variant shapes before any execution', () => {
    const invalidInputs: Array<{ input: Record<string, unknown>; reason: string }> = [
      { input: { command: 'run', taskConfig: { tasks: 'Award' } }, reason: 'tasks_array_required' },
      { input: { command: 'run', taskConfig: { tasks: [] } }, reason: 'tasks_empty' },
      { input: { command: 'run', taskConfig: { tasks: ['Award'] } }, reason: 'task_object_required' },
      {
        input: { command: 'run', taskConfig: { tasks: [{ name: '领取奖励', type: 'Award' }], extra: true } },
        reason: 'batch_field_unknown'
      },
      {
        input: {
          command: 'run',
          taskConfig: { tasks: [{ name: '动态任务', type: 'Award', condition: { type: 'Time' } }] }
        },
        reason: 'condition_must_be_in_variants'
      },
      {
        input: { command: 'run', taskConfig: { tasks: [{ name: '动态任务', type: 'Award', unknown: true }] } },
        reason: 'task_field_unknown'
      },
      {
        input: { command: 'run', taskConfig: { tasks: [{ name: '动态任务', type: 'Award', strategy: 'all' }] } },
        reason: 'strategy_invalid'
      },
      {
        input: { command: 'run', taskConfig: { tasks: [{ name: '动态任务', type: 'Award', variants: {} }] } },
        reason: 'variants_array_required'
      },
      {
        input: { command: 'run', taskConfig: { tasks: [{ name: '动态任务', type: 'Award', variants: ['always'] }] } },
        reason: 'variant_object_required'
      },
      {
        input: {
          command: 'run',
          taskConfig: { tasks: [{ name: '动态任务', type: 'Award', variants: [{ when: {} }] }] }
        },
        reason: 'variant_field_unknown'
      },
      {
        input: {
          command: 'run',
          taskConfig: { tasks: [{ name: '动态任务', type: 'Award', variants: [{ condition: 'always' }] }] }
        },
        reason: 'variant_condition_object_required'
      },
      {
        input: {
          command: 'run',
          taskConfig: { tasks: [{ name: '动态任务', type: 'Award', variants: [{ params: [] }] }] }
        },
        reason: 'variant_params_object_required'
      },
      {
        input: {
          command: 'run',
          taskConfig: { tasks: [{ name: '培养', type: 'OperProgress', params: { plans: [] } }] }
        },
        reason: 'game_task_params_invalid'
      },
      { input: { command: 'run', taskConfig: { tasks: [{ name: '动态任务', type: 'Bad Type' }] } }, reason: 'invalid_type' }
    ];

    for (const { input, reason } of invalidInputs) {
      assert.throws(
        () => preflightAgentTaskRequest(input),
        error => {
          const code = String(errorField(error, 'code'));
          assert.ok(
            ['AGENT_VALIDATION_TASK_CONFIG_INVALID', 'AGENT_VALIDATION_TASK_TYPE_INVALID'].includes(code),
            `unexpected error code ${code} for reason ${reason}`
          );
          const details = detailsOf(error);
          if (reason === 'invalid_type') {
            assert.ok(code === 'AGENT_VALIDATION_TASK_TYPE_INVALID');
          } else {
            assert.equal(details.reason, reason);
          }
          return true;
        }
      );
    }
  });

  it('attributes batch validation failures to their task index', () => {
    assert.throws(
      () => preflightAgentTaskRequest({
        command: 'run',
        taskConfig: { tasks: [{ name: '领取奖励', type: 'Award' }, { name: '培养', type: 'OperProgress', params: { plans: [] } }] }
      }),
      error => {
        assert.equal(errorField(error, 'code'), 'AGENT_VALIDATION_TASK_CONFIG_INVALID');
        assert.equal(detailsOf(error).taskIndex, 1);
        assert.equal(detailsOf(error).reason, 'game_task_params_invalid');
        return true;
      }
    );
  });

  it('rejects top-level condition and unknown single task fields', () => {
    for (const taskConfig of [
      { name: '动态任务', type: 'Award', condition: { type: 'Time' } },
      { name: '动态任务', type: 'Award', unknown: true }
    ]) {
      assert.throws(
        () => preflightAgentTaskRequest({ command: 'run', taskConfig }),
        error => errorField(error, 'code') === 'AGENT_VALIDATION_TASK_CONFIG_INVALID'
      );
    }
  });
});

describe('normalizeDailyFlowRequest', () => {
  it('normalizes the optional daily flow inputs', () => {
    assert.deepEqual(normalizeDailyFlowRequest({ scheduleId: '  morning  ', dryRun: true }), {
      dryRun: true,
      scheduleId: 'morning',
      taskFlow: null,
      waitForCompletion: true
    });
    assert.deepEqual(
      normalizeDailyFlowRequest({ waitForCompletion: false }).waitForCompletion,
      false
    );
  });

  it('rejects ambiguous daily flow input types', () => {
    assert.throws(
      () => normalizeDailyFlowRequest({ dryRun: 'false' }),
      error => errorField(error, 'code') === 'AGENT_VALIDATION_DRY_RUN_INVALID'
    );
    assert.throws(
      () => normalizeDailyFlowRequest({ waitForCompletion: 'false' }),
      error => errorField(error, 'code') === 'AGENT_VALIDATION_WAIT_FOR_COMPLETION_INVALID'
    );
    assert.throws(
      () => normalizeDailyFlowRequest({ taskFlow: {} }),
      error => errorField(error, 'code') === 'AGENT_VALIDATION_TASK_FLOW_INVALID'
    );
    assert.throws(
      () => normalizeDailyFlowRequest({ scheduleId: { id: 'morning' } }),
      error => errorField(error, 'code') === 'AGENT_VALIDATION_SCHEDULE_ID_INVALID'
    );
  });
});

describe('createDailyFlowExecutionError', () => {
  it('returns a retryable conflict for an occupied executor', () => {
    const owner = { taskName: '仓库识别', command: 'run' };
    const error = createDailyFlowExecutionError({
      success: false,
      busy: true,
      message: 'MAA 正在执行：仓库识别',
      owner
    })
    assert.ok(error);

    assert.equal(errorField(error, 'code'), 'AGENT_EXECUTION_BUSY');
    assert.equal(errorField(error, 'statusCode'), 409);
    assert.equal(errorField(error, 'retryable'), true);
    assert.deepEqual(detailsOf(error), { owner });
  });

  it('recognizes the scheduler already-running message as busy', () => {
    const error = createDailyFlowExecutionError({
      success: false,
      message: '已有任务流程正在执行'
    })
    assert.ok(error);

    assert.equal(errorField(error, 'code'), 'AGENT_EXECUTION_BUSY');
    assert.equal(errorField(error, 'statusCode'), 409);
    assert.deepEqual(detailsOf(error), { owner: null });
  });

  it('returns a non-retryable validation error for other rejections', () => {
    const result = { success: false, message: '自定义换班需要填写排班文件路径' };
    const error = createDailyFlowExecutionError(result);
    assert.ok(error);

    assert.equal(errorField(error, 'code'), 'AGENT_DAILY_FLOW_REJECTED');
    assert.equal(errorField(error, 'statusCode'), 400);
    assert.equal(errorField(error, 'retryable'), false);
    assert.deepEqual(detailsOf(error), { result });
  });

  it('returns null for successful or absent results', () => {
    assert.equal(createDailyFlowExecutionError({ success: true }), null);
    assert.equal(createDailyFlowExecutionError(null), null);
  });
});

describe('normalizeCopilotSetExecutionRequest', () => {
  it('maps the two legacy continuous modes to one server queue', () => {
    assert.equal(normalizeCopilotSetMode('app'), 'continuous');
    assert.equal(normalizeCopilotSetMode('cli'), 'continuous');
    assert.equal(normalizeCopilotSetMode(undefined), 'continuous');
    assert.equal(normalizeCopilotSetMode('manual'), 'manual');
    assert.throws(
      () => normalizeCopilotSetMode('auto'),
      error => errorField(error, 'code') === 'AGENT_VALIDATION_COPILOT_SET_MODE_INVALID' && errorField(error, 'statusCode') === 400
    );
  });

  it('normalizes selection and keeps the existing advanced options', () => {
    const request = normalizeCopilotSetExecutionRequest({
      mode: 'cli',
      raid: 'both',
      selectedIndexes: ['2', 0],
      options: { loopTimes: 3, formationMode: 'off' }
    });

    assert.deepEqual(request, {
      mode: 'continuous',
      raid: 'both',
      selectedIndexes: [2, 0],
      options: { loopTimes: 3, formationMode: 'off' },
      waitForCompletion: true
    });
  });

  it('keeps the legacy unknown-raid fallback and rejects malformed selection or options', () => {
    assert.equal(normalizeCopilotSetExecutionRequest({ raid: 'hard' }).raid, 'normal');
    assert.throws(
      () => normalizeCopilotSetExecutionRequest({ selectedIndexes: [-1] }),
      error => errorField(error, 'code') === 'AGENT_VALIDATION_COPILOT_SET_SELECTION_INVALID'
    );
    assert.throws(
      () => normalizeCopilotSetExecutionRequest({ options: [] }),
      error => errorField(error, 'code') === 'AGENT_VALIDATION_COPILOT_SET_OPTIONS_INVALID'
    );
  });
});
