// @vitest-environment node
// 跨端契约：客户端 option table 产出的动态任务参数必须能通过服务端 preflight。
// 两端各自维护用例时，参数名漂移（snake_case vs camelCase）不会让任何一侧变红；
// 这里把客户端构建结果直接喂给服务端创建 Run 前的同一道校验。
import { describe, expect, it } from 'vitest'
import { buildRoguelikeExecutionPlan } from '../../src/features/roguelike/model/roguelikeExecution.ts'
import type { RoguelikeAdvancedParams, RoguelikeTaskInputs } from '../../src/features/roguelike/types/index.ts'
import { preflightAgentTaskRequest } from '../../../server/src/services/agentActionService.ts'
import type { AgentTaskConfig } from '../../../server/src/services/agentActionService.ts'
import { GAME_TASK_PARAM_KEYS } from '../../../server/src/services/gameTaskConfigService.ts'
import { ROGUELIKE_OPTIONS } from '../../src/features/roguelike/model/roguelikeOptionTables.ts'
import { RECLAMATION_OPTIONS } from '../../src/features/roguelike/model/reclamationOptionTables.ts'

interface DynamicTaskCase {
  name: string
  taskId: 'roguelike' | 'reclamation'
  taskInputs: RoguelikeTaskInputs
  advancedParams: RoguelikeAdvancedParams
  expectedParams: Record<string, unknown>
}

function errorStatusCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null
  const statusCode = (error as Record<string, unknown>).statusCode
  return typeof statusCode === 'number' ? statusCode : null
}

function preflightStatus(input: unknown): number {
  try {
    preflightAgentTaskRequest(input)
    return 200
  } catch (error) {
    return errorStatusCode(error) ?? 500
  }
}

function buildDynamicTask(taskCase: DynamicTaskCase): AgentTaskConfig {
  const plan = buildRoguelikeExecutionPlan(taskCase.taskId, taskCase.taskInputs, taskCase.advancedParams)
  expect(plan.command, taskCase.name).toBe('run')
  expect(plan.taskConfig, taskCase.name).not.toBeNull()
  return plan.taskConfig as AgentTaskConfig
}

function preflightDynamicTask(taskCase: DynamicTaskCase): AgentTaskConfig {
  const plan = buildRoguelikeExecutionPlan(taskCase.taskId, taskCase.taskInputs, taskCase.advancedParams)
  expect(plan.command, taskCase.name).toBe('run')
  expect(preflightStatus({
    command: plan.command,
    args: [plan.params],
    taskConfig: plan.taskConfig
  }), taskCase.name).toBe(200)
  return plan.taskConfig as AgentTaskConfig
}

const dynamicTaskCases: DynamicTaskCase[] = [
  {
    name: '界园刷常乐节点',
    taskId: 'roguelike',
    taskInputs: { roguelike: 'JieGarden' },
    advancedParams: { roguelike: { mode: '20001', findPlayTimeTarget: '2', stopAtMaxLevel: true } },
    expectedParams: { theme: 'JieGarden', mode: 20001, find_playTime_target: 2, stop_at_max_level: true }
  },
  {
    name: '界园其它 Core 开关',
    taskId: 'roguelike',
    taskInputs: { roguelike: 'JieGarden' },
    advancedParams: { roguelike: { stopAtMaxLevel: true } },
    expectedParams: { theme: 'JieGarden', stop_at_max_level: true }
  },
  {
    name: '萨卡兹快速通过第一层',
    taskId: 'roguelike',
    taskInputs: { roguelike: 'Sarkaz' },
    advancedParams: { roguelike: { mode: '10001', stopAtMaxLevel: true } },
    expectedParams: { theme: 'Sarkaz', mode: 10001, stop_at_max_level: true }
  },
  {
    name: '萨卡兹刷源石锭种子开局',
    taskId: 'roguelike',
    taskInputs: { roguelike: 'Sarkaz' },
    advancedParams: {
      roguelike: {
        mode: '1',
        squad: '点刺成锭分队',
        startWithSeed: '2b3c4d,rogue_1,120',
        stopAtMaxLevel: true
      }
    },
    expectedParams: { theme: 'Sarkaz', mode: 1, start_with_seed: '2b3c4d,rogue_1,120' }
  },
  {
    name: '萨米刷坍缩范式首层密文板',
    taskId: 'roguelike',
    taskInputs: { roguelike: 'Sami' },
    advancedParams: {
      roguelike: {
        mode: '5',
        expectedCollapsalParadigms: '目空一些,睁眼瞎',
        firstFloorFoldartal: '英雄',
        stopAtMaxLevel: true
      }
    },
    expectedParams: {
      theme: 'Sami',
      mode: 5,
      expected_collapsal_paradigms: ['目空一些', '睁眼瞎'],
      first_floor_foldartal: '英雄'
    }
  },
  {
    name: '萨卡兹刷月度小队',
    taskId: 'roguelike',
    taskInputs: { roguelike: 'Sarkaz' },
    advancedParams: {
      roguelike: { mode: '6', monthlySquadAutoIterate: true, monthlySquadCheckComms: true }
    },
    expectedParams: {
      theme: 'Sarkaz',
      mode: 6,
      monthly_squad_auto_iterate: true,
      monthly_squad_check_comms: true
    }
  },
  {
    name: '傀影刷深入调查',
    taskId: 'roguelike',
    taskInputs: { roguelike: 'Phantom' },
    advancedParams: { roguelike: { mode: '7', deepExplorationAutoIterate: true } },
    expectedParams: { theme: 'Phantom', mode: 7, deep_exploration_auto_iterate: true }
  },
  {
    name: '黑流树海刷等级与培育目标',
    taskId: 'roguelike',
    taskInputs: { roguelike: 'BlackFlow' },
    advancedParams: {
      roguelike: {
        mode: '0',
        blackflowStrategy: 'baby_animal',
        blackflowCultivationTarget: 'swaddled_cat',
        stopAtMaxLevel: true
      }
    },
    expectedParams: {
      theme: 'BlackFlow',
      mode: 0,
      blackflow_strategy: 'baby_animal',
      blackflow_cultivation_target: 'swaddled_cat'
    }
  },
  {
    name: '黑流树海刷开局与保留目标局',
    taskId: 'roguelike',
    taskInputs: { roguelike: 'BlackFlow' },
    advancedParams: {
      roguelike: {
        mode: '30003',
        blackflowStartAnimals: '襁褓猫,襁褓狗',
        blackflowStartRewards: '未编号物,调查预付款'
      }
    },
    expectedParams: {
      theme: 'BlackFlow',
      mode: 30003,
      blackflow_start_animals: ['swaddled_cat', 'swaddled_dog'],
      blackflow_start_rewards: 3
    }
  },
  {
    name: '生息演算重启锚点',
    taskId: 'reclamation',
    taskInputs: { reclamation: 'RelaunchAnchor' },
    advancedParams: { reclamation: { mode: '16' } },
    expectedParams: { theme: 'RelaunchAnchor', mode: 16 }
  },
  {
    name: '生息演算清空商店',
    taskId: 'reclamation',
    taskInputs: { reclamation: 'Tales' },
    advancedParams: { reclamation: { mode: '0', clearStore: true } },
    expectedParams: { theme: 'Tales', mode: 0, clear_store: true }
  }
]

describe('client option table to server preflight contract', () => {
  for (const taskCase of dynamicTaskCases) {
    it(`accepts ${taskCase.name}`, () => {
      const taskConfig = preflightDynamicTask(taskCase)
      expect(taskConfig.params).toMatchObject(taskCase.expectedParams)
    })
  }

  it('has no snake_case roguelike target key outside the authoritative spelling', () => {
    for (const taskCase of dynamicTaskCases) {
      const taskConfig = preflightDynamicTask(taskCase)
      expect(taskConfig.params).not.toHaveProperty('find_play_time_target')
    }
  })

  it('rejects a misspelled target key before creating a run', () => {
    const taskConfig = buildDynamicTask(dynamicTaskCases[0] as DynamicTaskCase)
    const params = { ...taskConfig.params }
    delete params.find_playTime_target
    params.find_playtime_target = 2

    expect(preflightStatus({
      command: 'run',
      args: ['roguelike'],
      taskConfig: { ...taskConfig, params }
    })).toBe(400)
  })

  it('rejects conflicting legacy and authoritative target keys', () => {
    const taskConfig = buildDynamicTask(dynamicTaskCases[0] as DynamicTaskCase)

    expect(preflightStatus({
      command: 'run',
      args: ['roguelike'],
      taskConfig: {
        ...taskConfig,
        params: { ...taskConfig.params, find_play_time_target: 1 }
      }
    })).toBe(400)
  })
})

describe('client option table keys against the server validation registry', () => {
  const tables = [
    { type: 'Roguelike', options: ROGUELIKE_OPTIONS },
    { type: 'Reclamation', options: RECLAMATION_OPTIONS }
  ] as const

  it('only emits parameter keys the server validates', () => {
    for (const { type, options } of tables) {
      const known = GAME_TASK_PARAM_KEYS[type]
      expect(known, type).toBeDefined()
      if (!known) continue
      const clientKeys = [...new Set(
        options
          .map(option => option.coreParam)
          .filter((key): key is string => typeof key === 'string')
      )]
      expect(clientKeys.length, type).toBeGreaterThan(0)
      expect(clientKeys.filter(key => !known.has(key)), type).toEqual([])
    }
  })
})
