export const GAME_OPERATOR_ROLES = Object.freeze([
  'Unknown', 'Pioneer', 'Warrior', 'Tank', 'Sniper', 'Caster', 'Medic', 'Support', 'Special'
] as const);

const operatorRoles: ReadonlySet<string> = new Set(GAME_OPERATOR_ROLES);
const planFields = new Set(['role', 'name', 'elite', 'skill_level', 'skill_mastery']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integerBetween(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
}

export function validateGameTaskParams(type: string, params: Record<string, unknown>): string | null {
  if (type === 'SwitchTheme') {
    return Array.isArray(params.themes) && params.themes.every(theme => typeof theme === 'string' && theme.trim())
      ? null
      : 'SwitchTheme.params.themes 必须是主题名称字符串数组';
  }
  if (type !== 'OperProgress') return null;
  if (!Array.isArray(params.plans)) return 'OperProgress.params.plans 必须是培养计划数组';
  for (const [index, plan] of params.plans.entries()) {
    const prefix = `OperProgress.params.plans[${index}]`;
    if (!isRecord(plan)) return `${prefix} 必须是对象`;
    if (Object.keys(plan).some(key => !planFields.has(key))) return `${prefix} 包含不支持的培养字段`;
    if (typeof plan.name !== 'string' || !plan.name.trim()) return `${prefix}.name 必须是非空干员名`;
    if (plan.role !== undefined && (typeof plan.role !== 'string' || !operatorRoles.has(plan.role))) {
      return `${prefix}.role 必须是干员职业标识`;
    }
    if (plan.elite !== undefined && !integerBetween(plan.elite, 1, 2)) return `${prefix}.elite 必须是 1 或 2`;
    if (plan.skill_level !== undefined && !integerBetween(plan.skill_level, 2, 7)) {
      return `${prefix}.skill_level 必须是 2 至 7 的整数`;
    }
    if (plan.skill_mastery !== undefined && (!Array.isArray(plan.skill_mastery)
      || plan.skill_mastery.length !== 3
      || !plan.skill_mastery.every(level => integerBetween(level, 0, 3)))) {
      return `${prefix}.skill_mastery 必须是三个 0 至 3 的整数`;
    }
  }
  return null;
}
