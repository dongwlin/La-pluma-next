export const GAME_OPERATOR_ROLES = Object.freeze([
  'Unknown', 'Pioneer', 'Warrior', 'Tank', 'Sniper', 'Caster', 'Medic', 'Support', 'Special'
] as const);

/** 基建设施标识；与 MaaCore `Infrast` 的 facility 取值一致。 */
export const GAME_TASK_FACILITIES = Object.freeze([
  'Mfg', 'Trade', 'Power', 'Control', 'Reception', 'Office', 'Recycle', 'Dorm', 'Processing', 'Training', 'AssistantChange'
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
  }),
  Fight: Object.freeze({
    series: Object.freeze({ minimum: -1, maximum: 10 }),
    medicineExpireDays: Object.freeze({ minimum: 0 })
  }),
  Recruit: Object.freeze({
    extraTagsMode: Object.freeze([0, 1, 2] as const),
    permitReserveMinimum: 0,
    timesMinimum: 0
  }),
  Infrast: Object.freeze({
    modes: Object.freeze([0, 10000, 20000] as const),
    facilities: GAME_TASK_FACILITIES
  }),
  Award: Object.freeze({
    switches: Object.freeze(['award', 'mail', 'recruit', 'orundum', 'mining', 'specialaccess', 'signinevent'] as const)
  }),
  StartUp: Object.freeze({
    clientTypes: Object.freeze(['Official', 'Bilibili', 'Txwy', 'YoStarEN', 'YoStarJP', 'YoStarKR'] as const)
  })
});

const operatorRoles: ReadonlySet<string> = new Set(GAME_OPERATOR_ROLES);
const planFields = new Set<string>(GAME_TASK_LIMITS.OperProgress.planFields);
const facilities: ReadonlySet<string> = new Set(GAME_TASK_LIMITS.Infrast.facilities);
const infrastructures: ReadonlySet<number> = new Set(GAME_TASK_LIMITS.Infrast.modes);
const clientTypes: ReadonlySet<string> = new Set(GAME_TASK_LIMITS.StartUp.clientTypes);
const awardSwitches = GAME_TASK_LIMITS.Award.switches;

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

/** 参数可能以字符串形式来自旧草稿或表单；只把可无损解析的整数视为合法。 */
function integerValueOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

function isOmitted(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function validateIntegerField(
  value: unknown,
  field: string,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY
): string | null {
  if (isOmitted(value)) return null;
  const parsed = integerValueOf(value);
  if (parsed === null) return `${field} 必须是整数`;
  if (parsed < minimum || parsed > maximum) {
    return maximum === Number.POSITIVE_INFINITY
      ? `${field} 不能小于 ${minimum}`
      : `${field} 必须是 ${minimum} 至 ${maximum} 的整数`;
  }
  return null;
}

function validateBooleanField(value: unknown, field: string): string | null {
  return value === undefined || value === null || typeof value === 'boolean' ? null : `${field} 必须是布尔值`;
}

function validateFightParams(params: Record<string, unknown>): string | null {
  const series = validateIntegerField(
    params.series,
    'Fight.params.series',
    GAME_TASK_LIMITS.Fight.series.minimum,
    GAME_TASK_LIMITS.Fight.series.maximum
  );
  if (series) return series;

  const medicineExpireDays = validateIntegerField(
    params.medicine_expire_days ?? params.medicineExpireDays,
    'Fight.params.medicine_expire_days',
    GAME_TASK_LIMITS.Fight.medicineExpireDays.minimum
  );
  if (medicineExpireDays) return medicineExpireDays;

  const legacyExpiringMedicine = validateIntegerField(
    params.expiring_medicine ?? params.expiringMedicine,
    'Fight.params.expiring_medicine',
    GAME_TASK_LIMITS.Fight.medicineExpireDays.minimum
  );
  if (legacyExpiringMedicine) return legacyExpiringMedicine;

  return validateIntegerField(params.medicine, 'Fight.params.medicine', GAME_TASK_LIMITS.Fight.medicineExpireDays.minimum);
}

function validateRecruitParams(params: Record<string, unknown>): string | null {
  for (const field of ['refresh', 'force_refresh', 'set_time', 'expedite'] as const) {
    const message = validateBooleanField(params[field], `Recruit.params.${field}`);
    if (message) return message;
  }

  const permitReserve = validateIntegerField(
    params.level3_recruitment_permit_reserve,
    'Recruit.params.level3_recruitment_permit_reserve',
    GAME_TASK_LIMITS.Recruit.permitReserveMinimum
  );
  if (permitReserve) return permitReserve;

  const times = validateIntegerField(
    params.times,
    'Recruit.params.times',
    GAME_TASK_LIMITS.Recruit.timesMinimum
  );
  if (times) return times;

  for (const field of ['select', 'confirm'] as const) {
    const value = params[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some(entry => integerValueOf(entry) === null)) {
      return `Recruit.params.${field} 必须是星级整数数组`;
    }
  }

  const extraTagsMode = params.extra_tags_mode;
  const extraTagsModeValue = integerValueOf(extraTagsMode);
  if (!isOmitted(extraTagsMode)
    && (extraTagsModeValue === null || !GAME_TASK_LIMITS.Recruit.extraTagsMode.some(mode => mode === extraTagsModeValue))) {
    return 'Recruit.params.extra_tags_mode 必须是 0、1 或 2';
  }

  return null;
}

function validateInfrastParams(params: Record<string, unknown>): string | null {
  const mode = integerValueOf(params.mode);
  if (!isOmitted(params.mode) && (mode === null || !infrastructures.has(mode))) {
    return 'Infrast.params.mode 必须是 0、10000 或 20000';
  }

  const facility = params.facility;
  if (facility !== undefined) {
    if (!Array.isArray(facility) || facility.some(entry => typeof entry !== 'string' || !facilities.has(entry))) {
      return `Infrast.params.facility 只能包含 ${GAME_TASK_LIMITS.Infrast.facilities.join('/')}`;
    }
  }

  return null;
}

function validateAwardParams(params: Record<string, unknown>): string | null {
  for (const field of awardSwitches) {
    const message = validateBooleanField(params[field], `Award.params.${field}`);
    if (message) return message;
  }
  return null;
}

function validateStartUpParams(params: Record<string, unknown>): string | null {
  const enabled = validateBooleanField(params.start_game_enabled, 'StartUp.params.start_game_enabled');
  if (enabled) return enabled;

  const accountName = params.account_name ?? params.accountName;
  if (accountName !== undefined && accountName !== null && typeof accountName !== 'string') {
    return 'StartUp.params.account_name 必须是字符串';
  }

  const clientType = params.client_type ?? params.clientType;
  if (clientType !== undefined && clientType !== null && clientType !== '') {
    if (typeof clientType !== 'string' || !clientTypes.has(clientType)) {
      return `StartUp.params.client_type 必须是 ${GAME_TASK_LIMITS.StartUp.clientTypes.join('/')} 之一`;
    }
  }

  return null;
}

export function validateGameTaskParams(type: string, params: Record<string, unknown>): string | null {
  const limits = GAME_TASK_LIMITS.OperProgress;
  if (type === 'SwitchTheme') {
    return Array.isArray(params.themes) && params.themes.every(theme => typeof theme === 'string' && theme.trim())
      ? null
      : 'SwitchTheme.params.themes 必须是主题名称字符串数组';
  }
  if (type === 'Fight') return validateFightParams(params);
  if (type === 'Recruit') return validateRecruitParams(params);
  if (type === 'Infrast') return validateInfrastParams(params);
  if (type === 'Award') return validateAwardParams(params);
  if (type === 'StartUp') return validateStartUpParams(params);
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
