import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildFightStagePlans,
  executeFightStages,
  normalizeFightStages
} from '../fightExecutionService.ts';
import type { FightExecutionPorts } from '../fightExecutionService.ts';
import type { MaaCommandOutput } from '../maaProcessService.ts';

interface CommandCall {
  args: readonly string[];
  taskName: string;
}

function createPorts(overrides: Partial<FightExecutionPorts> = {}) {
  const calls = {
    commands: [] as CommandCall[],
    leases: 0,
    activeLeases: 0
  };
  let stop = false;

  const ports: FightExecutionPorts = {
    executeStage: async (args, taskName): Promise<MaaCommandOutput> => {
      calls.commands.push({ args, taskName });
      return { stdout: `${args[0]} done`, stderr: '', command: `maa fight ${args.join(' ')}` };
    },
    withExecutionLease: async <T>(_request: unknown, run: () => Promise<T>): Promise<T> => {
      calls.leases += 1;
      calls.activeLeases += 1;
      try {
        return await run();
      } finally {
        calls.activeLeases -= 1;
      }
    },
    sleep: async () => {},
    ...overrides
  };

  return {
    ports,
    calls,
    requestStop: () => { stop = true; },
    shouldStop: () => stop
  };
}

describe('fight stage planning', () => {
  it('normalizes stage entries and keeps per-stage times out of the stage argument', () => {
    const stages = normalizeFightStages([
      { stage: '1-7', times: 3 },
      'CE-6:2',
      { stage: '  AP-5  ' },
      { stage: '' },
      null
    ]);

    assert.deepEqual(stages, [
      { stage: '1-7', times: '3' },
      { stage: 'CE-6', times: '2' },
      { stage: 'AP-5', times: '' }
    ]);
  });

  it('splits legacy packed stage strings into per-stage entries', () => {
    assert.deepEqual(
      normalizeFightStages(['1-7:3,CE-6', { stage: 'AP-5:2,SK-5' }]),
      [
        { stage: '1-7', times: '3' },
        { stage: 'CE-6', times: '' },
        { stage: 'AP-5', times: '2' },
        { stage: 'SK-5', times: '' }
      ]
    );

    assert.deepEqual(
      normalizeFightStages(undefined, '1-7:3,CE-6', 5),
      [
        { stage: '1-7', times: '3' },
        { stage: 'CE-6', times: '' }
      ]
    );
  });

  it('builds one maa-cli argument list per stage with --times and shared options', () => {
    const stages = normalizeFightStages([{ stage: '1-7', times: 3 }, 'CE-6']);
    const plans = buildFightStagePlans(stages, {
      medicine: 2,
      expiringMedicine: 0,
      stone: 0,
      series: 6
    });

    assert.deepEqual(plans, [
      {
        stage: '1-7',
        times: '3',
        args: ['1-7', '--times', '3', '-m', '2', '--expiring-medicine', '0', '--stone', '0', '--series=6']
      },
      {
        stage: 'CE-6',
        times: '',
        args: ['CE-6', '-m', '2', '--expiring-medicine', '0', '--stone', '0', '--series=6']
      }
    ]);
    assert.equal(plans.some(plan => plan.args.some(arg => arg.includes(','))), false);
  });

  it('keeps a negative series value as one clap token', () => {
    const [plan] = buildFightStagePlans([{ stage: '1-7', times: '12' }], { series: -1 });
    assert.deepEqual(plan.args, ['1-7', '--times', '12', '--series=-1']);
  });
});

describe('fight stage execution', () => {
  it('executes every stage in order under one execution lease', async () => {
    const { ports, calls } = createPorts({
      executeStage: async (args, taskName) => {
        assert.equal(calls.activeLeases, 1);
        calls.commands.push({ args, taskName });
        return { stdout: `${args[0]} done`, stderr: '', command: `maa fight ${args.join(' ')}` };
      }
    });

    const result = await executeFightStages({
      stages: normalizeFightStages([{ stage: '1-7', times: 3 }, { stage: 'CE-6', times: 2 }]),
      options: { medicine: 0, series: 0 },
      taskName: 'Agent: 理智作战',
      betweenStageDelayMs: 0,
      ports
    });

    assert.equal(result.stopped, false);
    assert.deepEqual(calls.commands.map(call => call.args[0]), ['1-7', 'CE-6']);
    assert.deepEqual(calls.commands[0].args.slice(0, 3), ['1-7', '--times', '3']);
    assert.deepEqual(calls.commands[1].args.slice(0, 3), ['CE-6', '--times', '2']);
    assert.deepEqual(result.stages.map(stage => stage.status), ['success', 'success']);
    assert.equal(result.stdout, '1-7 done\nCE-6 done');
    assert.equal(result.command, 'maa fight CE-6 --times 2 -m 0 --series=0');
    assert.equal(calls.leases, 1);
    assert.equal(calls.activeLeases, 0);
  });

  it('stops before the next stage without starting it', async () => {
    const control = createPorts();
    const { ports, calls } = control;
    ports.executeStage = async (args, taskName) => {
      calls.commands.push({ args, taskName });
      control.requestStop();
      return { stdout: `${args[0]} done`, stderr: '', command: `maa fight ${args.join(' ')}` };
    };

    const result = await executeFightStages({
      stages: normalizeFightStages([{ stage: '1-7', times: 3 }, { stage: 'CE-6', times: 2 }]),
      options: { medicine: 0, series: 0 },
      taskName: 'Agent: 理智作战',
      shouldStop: control.shouldStop,
      betweenStageDelayMs: 0,
      ports
    });

    assert.equal(result.stopped, true);
    assert.equal(calls.commands.length, 1);
    assert.deepEqual(result.stages.map(stage => stage.status), ['success', 'pending']);
    assert.equal(result.stages[1].stage, 'CE-6');
  });

  it('settles as stopped when the current stage process is terminated by a stop request', async () => {
    const control = createPorts({
      executeStage: async () => {
        const error = Object.assign(new Error('command stopped'), {
          stopped: true,
          stdout: '',
          stderr: 'terminated'
        });
        throw error;
      }
    });

    const result = await executeFightStages({
      stages: normalizeFightStages([{ stage: '1-7', times: 3 }, { stage: 'CE-6', times: 2 }]),
      options: { medicine: 0, series: 0 },
      taskName: 'Agent: 理智作战',
      shouldStop: control.shouldStop,
      betweenStageDelayMs: 0,
      ports: control.ports
    });

    assert.equal(result.stopped, true);
    assert.deepEqual(result.stages.map(stage => stage.status), ['stopped', 'pending']);
    assert.equal(result.stages[0].stderr, 'terminated');
    assert.equal(control.calls.commands.length, 0);
  });

  it('treats a closed stage as skipped and continues with the next stage', async () => {
    const control = createPorts();
    control.ports.executeStage = async (args, taskName) => {
      control.calls.commands.push({ args, taskName });
      if (args[0] === 'CE-6') {
        throw Object.assign(new Error('stage not open'), { stdout: '', stderr: '' });
      }
      return { stdout: '1-7 done', stderr: '', command: 'maa fight 1-7' };
    };

    const result = await executeFightStages({
      stages: normalizeFightStages([{ stage: '1-7', times: 1 }, { stage: 'CE-6', times: 1 }]),
      options: { medicine: 0, series: 0 },
      taskName: 'Agent: 理智作战',
      betweenStageDelayMs: 0,
      ports: control.ports
    });

    assert.equal(result.stopped, false);
    assert.deepEqual(result.stages.map(stage => stage.status), ['success', 'skipped']);
    assert.match(result.stages[1].message, /关卡未开放/);
    assert.equal(control.calls.commands.length, 2);
  });

  it('fails the sequence with prior stage outcomes and keeps the remaining stages unstarted', async () => {
    const control = createPorts();
    control.ports.executeStage = async (args, taskName) => {
      control.calls.commands.push({ args, taskName });
      if (args[0] === 'CE-6') {
        throw Object.assign(new Error('network down'), {
          code: 'MAA_COMMAND_FAILED',
          statusCode: 502,
          stdout: '',
          stderr: 'adb offline'
        });
      }
      return { stdout: '1-7 done', stderr: '', command: 'maa fight 1-7' };
    };

    let failure: unknown;
    try {
      await executeFightStages({
        stages: normalizeFightStages([{ stage: '1-7', times: 1 }, { stage: 'CE-6', times: 1 }, { stage: 'AP-5', times: 1 }]),
        options: { medicine: 0, series: 0 },
        taskName: 'Agent: 理智作战',
        betweenStageDelayMs: 0,
        ports: control.ports
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure instanceof Error);
    assert.match(failure.message, /CE-6 作战失败：network down/);
    assert.equal(control.calls.commands.length, 2);
    assert.equal(control.calls.activeLeases, 0);
    const details = (failure as Error & {
      code?: string;
      statusCode?: number;
      details?: { stage?: string; stageIndex?: number; stages?: Array<{ stage: string; status: string }> };
    }).details;
    assert.equal((failure as Error & { code?: string }).code, 'MAA_COMMAND_FAILED');
    assert.equal((failure as Error & { statusCode?: number }).statusCode, 502);
    assert.equal(details?.stage, 'CE-6');
    assert.equal(details?.stageIndex, 2);
    assert.deepEqual(details?.stages?.map(stage => [stage.stage, stage.status]), [
      ['1-7', 'success'],
      ['CE-6', 'failed'],
      ['AP-5', 'pending']
    ]);
  });

  it('skips the remaining stages once sanity is depleted', async () => {
    const control = createPorts({
      executeStage: async (args, taskName) => {
        control.calls.commands.push({ args, taskName });
        return {
          stdout: '理智不足\nSummary\n[Fight]\nCompleted',
          stderr: '',
          command: `maa fight ${args.join(' ')}`
        };
      }
    });

    const result = await executeFightStages({
      stages: normalizeFightStages([{ stage: '1-7', times: 3 }, { stage: 'CE-6', times: 2 }]),
      options: { medicine: 0, series: 0 },
      taskName: 'Agent: 理智作战',
      betweenStageDelayMs: 0,
      ports: control.ports
    });

    assert.equal(result.stopped, false);
    assert.equal(control.calls.commands.length, 1);
    assert.deepEqual(result.stages.map(stage => stage.status), ['success', 'skipped']);
    assert.match(result.stages[1].message, /理智已耗尽/);
  });
});
