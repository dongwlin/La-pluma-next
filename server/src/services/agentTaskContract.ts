import { GAME_OPERATOR_ROLES, GAME_TASK_LIMITS } from './gameTaskConfigService.ts';

/** 契约中可由 manifest 用当前运行配置替换的默认值键。 */
export type RuntimeDefaultKey = 'adbPath' | 'adbAddress' | 'clientType';

export type JsonSchemaType = 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';

/** 能力清单使用的 JSON Schema 子集；未知关键字保持原样透传。 */
export interface JsonSchema {
  $ref?: string;
  type?: JsonSchemaType | readonly JsonSchemaType[];
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  oneOf?: readonly JsonSchema[];
  anyOf?: readonly JsonSchema[];
  allOf?: readonly JsonSchema[];
  if?: JsonSchema;
  then?: JsonSchema;
  not?: JsonSchema;
  contains?: JsonSchema;
  enum?: readonly (string | number | boolean | null)[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  default?: unknown;
  description?: string;
  examples?: readonly unknown[];
  /** 构建 manifest 时替换为当前运行配置；OpenAPI 文档不输出该标记。 */
  'x-la-pluma-runtime-default'?: RuntimeDefaultKey;
}

const OPER_PROGRESS_LIMITS = GAME_TASK_LIMITS.OperProgress;
const SWITCH_THEME_LIMITS = GAME_TASK_LIMITS.SwitchTheme;

const AGENT_TASK_STRATEGY_SCHEMA = {
  type: 'string',
  enum: ['first', 'merge'],
  default: 'first',
  description: 'How maa-cli combines matching variants: first uses the first active variant (default); merge applies all active variants in order, later params overriding earlier ones.'
} as const satisfies JsonSchema;

const AGENT_TASK_VARIANT_SCHEMA = {
  type: 'object',
  properties: {
    condition: {
      type: 'object',
      additionalProperties: true,
      description: 'Upstream maa-cli variant condition (Time, DateTime, Weekday, DayMod, OnSideStory, And, Or, Not). Omitted means the variant is always active.'
    },
    params: {
      type: 'object',
      additionalProperties: true,
      description: 'Parameters merged into the task params when this variant matches.'
    }
  },
  additionalProperties: false
} as const satisfies JsonSchema;

const AGENT_DYNAMIC_TASK_ENTRY_SCHEMA = {
  type: 'object',
  required: ['name', 'type'],
  properties: {
    name: { type: 'string', minLength: OPER_PROGRESS_LIMITS.nameMinLength },
    type: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z][A-Za-z0-9_]*$',
      examples: ['OperProgress', 'SwitchTheme']
    },
    params: { type: 'object', additionalProperties: true },
    strategy: AGENT_TASK_STRATEGY_SCHEMA,
    variants: {
      type: 'array',
      items: AGENT_TASK_VARIANT_SCHEMA,
      description: 'Upstream maa-cli task variants. Conditions select variants and are evaluated by maa-cli at task start; condition must be nested here, never on the task itself.'
    }
  },
  not: { required: ['condition'] },
  allOf: [
    {
      if: { properties: { type: { const: 'OperProgress' } }, required: ['type'] },
      then: {
        required: ['params'],
        properties: {
          params: {
            type: 'object',
            required: ['plans'],
            properties: {
              plans: {
                type: 'array',
                minItems: OPER_PROGRESS_LIMITS.minPlans,
                description: 'Operator plans. Each plan must target elite, skill_level or at least one positive skill_mastery slot.',
                items: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    role: {
                      type: 'string',
                      enum: [...GAME_OPERATOR_ROLES],
                      description: 'Operator profession. Omit only when Core can infer a unique role from the name.'
                    },
                    name: { type: 'string', minLength: OPER_PROGRESS_LIMITS.nameMinLength },
                    elite: {
                      type: 'integer',
                      minimum: OPER_PROGRESS_LIMITS.elite.minimum,
                      maximum: OPER_PROGRESS_LIMITS.elite.maximum
                    },
                    skill_level: {
                      type: 'integer',
                      minimum: OPER_PROGRESS_LIMITS.skillLevel.minimum,
                      maximum: OPER_PROGRESS_LIMITS.skillLevel.maximum
                    },
                    skill_mastery: {
                      type: 'array',
                      minItems: OPER_PROGRESS_LIMITS.mastery.length,
                      maxItems: OPER_PROGRESS_LIMITS.mastery.length,
                      items: {
                        type: 'integer',
                        minimum: OPER_PROGRESS_LIMITS.mastery.minimum,
                        maximum: OPER_PROGRESS_LIMITS.mastery.maximum
                      },
                      description: 'S1/S2/S3 target mastery levels; 0 leaves a skill unchanged. Starting training does not mean its training timer has finished.'
                    }
                  },
                  anyOf: [
                    { required: ['elite'] },
                    { required: ['skill_level'] },
                    {
                      required: ['skill_mastery'],
                      properties: {
                        skill_mastery: {
                          contains: { type: 'integer', minimum: OPER_PROGRESS_LIMITS.mastery.positiveMinimum }
                        }
                      }
                    }
                  ],
                  additionalProperties: false
                }
              }
            },
            additionalProperties: true
          }
        }
      }
    },
    {
      if: { properties: { type: { const: 'SwitchTheme' } }, required: ['type'] },
      then: {
        required: ['params'],
        properties: {
          params: {
            type: 'object', required: ['themes'],
            properties: {
              themes: {
                type: 'array', items: { type: 'string', minLength: SWITCH_THEME_LIMITS.themeMinLength },
                description: 'Exact in-game theme names. Multiple candidates select one at random; an empty list is skipped.'
              }
            },
            additionalProperties: true
          }
        }
      }
    }
  ],
  additionalProperties: false
} as const satisfies JsonSchema;

/**
 * `run_task.taskConfig` 的唯一契约定义：manifest/OpenAPI 从这里取 schema，
 * 运行时校验与它共享同一组字段、范围与任务类型标识规则。支持旧单任务对象、
 * 新的多任务对象（`{tasks:[...]}`，每项保留上游 params/strategy/variants）
 * 以及 JSON 编码字符串；三者为互斥形状。
 */
export const AGENT_TASK_CONFIG_SCHEMA = {
  oneOf: [
    AGENT_DYNAMIC_TASK_ENTRY_SCHEMA,
    {
      type: 'object',
      required: ['tasks'],
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          items: AGENT_DYNAMIC_TASK_ENTRY_SCHEMA,
          description: 'Ordered task templates executed one by one. Each item keeps its own params, strategy and variants; per-task results are archived under result.tasks[index].'
        }
      },
      additionalProperties: false
    },
    { type: 'string', description: 'A JSON-encoded task configuration object.' }
  ],
  description: 'When supplied, La Pluma Next writes validated temporary MAA task files and executes them. A single task object is the legacy shape; {tasks:[...]} runs the list in order, each item in its own maa-cli invocation. Variants and strategy are passed through to maa-cli for evaluation. Game task outcomes are available in actions; failed operator sub-actions fail a standalone Run even when the CLI exits successfully. Missing callbacks leave the game result unconfirmed.',
  examples: [
    { name: '游戏内培养', type: 'OperProgress', params: { plans: [{ role: 'Caster', name: '阿米娅', elite: 2, skill_level: 7 }] } },
    { name: '游戏界面主题更换', type: 'SwitchTheme', params: { themes: ['默认'] } },
    {
      tasks: [
        { name: '领取奖励', type: 'Award', params: { award: true } },
        {
          name: '基建换班',
          type: 'Infrast',
          strategy: 'merge',
          variants: [
            { condition: { type: 'Weekday', weekdays: ['Mon'] }, params: { plan_index: 0 } },
            { condition: { type: 'Time', start: '18:00:00' }, params: { plan_index: 1 } }
          ]
        }
      ]
    }
  ]
} as const satisfies JsonSchema;
