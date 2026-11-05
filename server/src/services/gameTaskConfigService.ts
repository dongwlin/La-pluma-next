export const GAME_OPERATOR_ROLES = Object.freeze([
  'Unknown', 'Pioneer', 'Warrior', 'Tank', 'Sniper', 'Caster', 'Medic', 'Support', 'Special'
] as const);

/** 游戏任务参数约束的唯一来源：运行时校验与 Agent 契约 schema 共用这些值。 */
export const GAME_TASK_LIMITS = Object.freeze({
  OperProgress: Object.freeze({
    minPlans: 1,
    nameMinLength: 1,
    planFields: Object.freeze(['role', 'name', 'elite', 'skill_level', 'skill_mastery'] as const),
    elite: Object.freeze({ minimum: 1, maximum: 2 }),
    skillLevel: Object.freeze({ minimum: 2, maximum: 7 }),
    mastery: Object.freeze({ length: 3, minimum: 0, maximum: 3, positiveMinimum: 1 })
  }),
  SwitchTheme: Object.freeze({
    themeMinLength: 1
  })
});

const operatorRoles: ReadonlySet<string> = new Set(GAME_OPERATOR_ROLES);
const planFields = new Set<string>(GAME_TASK_LIMITS.OperProgress.planFields);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integerBetween(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function hasMasteryTarget(value: unknown): boolean {
  return Array.isArray(value)
    && value.some(level => integerBetween(level, GAME_TASK_LIMITS.OperProgress.mastery.positiveMinimum, GAME_TASK_LIMITS.OperProgress.mastery.maximum));
}

export function validateGameTaskParams(type: string, params: Record<string, unknown>): string | null {
  const limits = GAME_TASK_LIMITS.OperProgress;
  if (type === 'SwitchTheme') {
    return Array.isArray(params.themes) && params.themes.every(theme => typeof theme === 'string' && theme.trim())
      ? null
      : 'SwitchTheme.params.themes 必须是主题名称字符串数组';
  }
  if (type !== 'OperProgress') return null;
  if (!Array.isArray(params.plans)) return 'OperProgress.params.plans 必须是培养计划数组';
  if (params.plans.length === 0) return 'OperProgress.params.plans 至少包含一项培养计划';
  for (const [index, plan] of params.plans.entries()) {
    const prefix = `OperProgress.params.plans[${index}]`;
    if (!isRecord(plan)) return `${prefix} 必须是对象`;
    if (Object.keys(plan).some(key => !planFields.has(key))) return `${prefix} 包含不支持的培养字段`;
    if (typeof plan.name !== 'string' || !plan.name.trim()) return `${prefix}.name 必须是非空干员名`;
    if (plan.role !== undefined && (typeof plan.role !== 'string' || !operatorRoles.has(plan.role))) {
      return `${prefix}.role 必须是干员职业标识`;
    }
    if (plan.elite !== undefined && !integerBetween(plan.elite, limits.elite.minimum, limits.elite.maximum)) {
      return `${prefix}.elite 必须是 1 或 2`;
    }
    if (plan.skill_level !== undefined
      && !integerBetween(plan.skill_level, limits.skillLevel.minimum, limits.skillLevel.maximum)) {
      return `${prefix}.skill_level 必须是 2 至 7 的整数`;
    }
    if (plan.skill_mastery !== undefined && (!Array.isArray(plan.skill_mastery)
      || plan.skill_mastery.length !== limits.mastery.length
      || !plan.skill_mastery.every(level => integerBetween(level, limits.mastery.minimum, limits.mastery.maximum)))) {
      return `${prefix}.skill_mastery 必须是三个 0 至 3 的整数`;
    }
    if (plan.elite === undefined && plan.skill_level === undefined
      && !hasMasteryTarget(plan.skill_mastery)) {
      return `${prefix} 至少选择一个培养目标`;
    }
  }
  return null;
}
