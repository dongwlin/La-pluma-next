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
  if (type === 'Roguelike') {
    return validateRoguelikeParams(params);
  }
  if (type === 'Reclamation') {
    return validateReclamationParams(params);
  }
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

const ROGUELIKE_THEMES = Object.freeze(['Phantom', 'Mizuki', 'Sami', 'Sarkaz', 'JieGarden', 'BlackFlow'] as const);
const RECLAMATION_THEMES = Object.freeze(['Tales', 'RelaunchAnchor'] as const);
const ROGUELIKE_COMMON_MODES: readonly number[] = Object.freeze([0, 1, 4, 6, 7]);
const ROGUELIKE_MODES_BY_THEME: Readonly<Record<string, readonly number[]>> = Object.freeze({
  Phantom: ROGUELIKE_COMMON_MODES,
  Mizuki: ROGUELIKE_COMMON_MODES,
  Sami: Object.freeze([...ROGUELIKE_COMMON_MODES, 5]),
  Sarkaz: Object.freeze([...ROGUELIKE_COMMON_MODES, 10001]),
  JieGarden: Object.freeze([...ROGUELIKE_COMMON_MODES, 20001]),
  BlackFlow: Object.freeze([0, 1, 30001, 30003])
});
const RECLAMATION_MODES_BY_THEME: Readonly<Record<string, readonly number[]>> = Object.freeze({
  Tales: Object.freeze([0, 1]),
  RelaunchAnchor: Object.freeze([16, 32, 48])
});

const ROGUELIKE_BOOLEAN_FIELDS = Object.freeze([
  'use_support', 'use_nonfriend_support', 'investment_enabled', 'investment_with_more_score',
  'stop_when_investment_full', 'start_with_elite_two', 'only_start_with_elite_two',
  'stop_at_final_boss', 'stop_at_max_level', 'refresh_trader_with_dice', 'use_foldartal',
  'check_collapsal_paradigms', 'double_check_collapsal_paradigms', 'monthly_squad_auto_iterate',
  'monthly_squad_check_comms', 'deep_exploration_auto_iterate', 'collectible_mode_shopping',
  'blackflow_start_utopia'
] as const);
const ROGUELIKE_STRING_FIELDS = Object.freeze([
  'squad', 'roles', 'core_char', 'first_floor_foldartal', 'collectible_mode_squad',
  'collectible_mode_roles'
] as const);
const ROGUELIKE_INTEGER_FIELDS = Object.freeze(['starts_count', 'difficulty', 'investments_count'] as const);
const ROGUELIKE_STRING_ARRAY_FIELDS = Object.freeze([
  'start_foldartal_list', 'expected_collapsal_paradigms'
] as const);
const ROGUELIKE_BLACKFLOW_ANIMALS = Object.freeze([
  'swaddled_cat', 'swaddled_dog', 'swaddled_cerberus', 'swaddled_feathered_serpent'
] as const);
const ROGUELIKE_BLACKFLOW_REWARDS = Object.freeze([
  'unnumbered_item', 'survey_advance', 'space_lease', 'regression_compensation',
  'forest_ride', 'nest_parasitism', 'pegasus', 'hippogriff', 'dragon', 'hydra', 'bai_ze', 'golden_crow'
] as const);
const ROGUELIKE_BLACKFLOW_STRATEGIES = Object.freeze([
  'baby_animal', 'investment', 'burn_with_investment', 'burn', 'ending1', 'ending2', 'ending3'
] as const);
const ROGUELIKE_BLACKFLOW_CULTIVATION_TARGETS = Object.freeze([
  'swaddled_cat', 'swaddled_feathered_serpent', 'swaddled_dog', 'swaddled_cerberus'
] as const);
const ROGUELIKE_START_LIST_KEYS = Object.freeze(['hot_water', 'shield', 'ingot', 'hope', 'random', 'key', 'dice', 'ideas'] as const);

function isIntegerValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isStringArrayValue(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function validateRoguelikeStringArrayField(
  prefix: string,
  field: string,
  value: unknown
): string | null {
  return isStringArrayValue(value) ? null : `${prefix}.params.${field} 必须是字符串数组`;
}

function validateRoguelikeBlackflowAnimals(animals: unknown, prefix: string): string | null {
  if (!isStringArrayValue(animals)) {
    return `${prefix}.params.blackflow_start_animals 必须是动物标识字符串数组`;
  }
  if (animals.length > 2) return `${prefix}.params.blackflow_start_animals 最多包含两项`;
  for (const animal of animals) {
    if (!(ROGUELIKE_BLACKFLOW_ANIMALS as readonly string[]).includes(animal)) {
      return `${prefix}.params.blackflow_start_animals 含未知动物 ${animal}，可选：${ROGUELIKE_BLACKFLOW_ANIMALS.join('、')}`;
    }
  }
  if (animals.filter(animal => animal === 'swaddled_feathered_serpent').length > 1) {
    return `${prefix}.params.blackflow_start_animals 最多包含一项襁褓羽蛇`;
  }
  return null;
}

function validateRoguelikeBlackflowStartList(value: unknown, prefix: string): string | null {
  if (!isRecord(value)) return `${prefix}.params.collectible_mode_start_list 必须是对象`;
  for (const key of ROGUELIKE_START_LIST_KEYS) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      return `${prefix}.params.collectible_mode_start_list.${key} 必须是布尔值`;
    }
  }
  return null;
}

function validateRoguelikeCoreCharList(value: unknown, prefix: string): string | null {
  if (!Array.isArray(value) || !value.every(entry => isRecord(entry) && typeof entry.name === 'string')) {
    return `${prefix}.params.core_char_list 必须是 { name, use_support? } 对象数组`;
  }
  return null;
}

function validateRoguelikeBlackflowStartRewardPriority(value: unknown, prefix: string): string | null {
  if (!isStringArrayValue(value) || value.length === 0) {
    return `${prefix}.params.blackflow_start_reward_priority 在 blackflow_start_utopia 启用时必须是奖励标识数组`;
  }
  const seen = new Set<string>();
  for (const reward of value) {
    if (!(ROGUELIKE_BLACKFLOW_REWARDS as readonly string[]).includes(reward)) {
      return `${prefix}.params.blackflow_start_reward_priority 含未知奖励 ${reward}`;
    }
    if (seen.has(reward)) {
      return `${prefix}.params.blackflow_start_reward_priority 不能包含重复奖励 ${reward}`;
    }
    seen.add(reward);
  }
  return null;
}

function validateRoguelikeParams(params: Record<string, unknown>): string | null {
  const prefix = 'Roguelike';

  if (params.theme !== undefined
    && (typeof params.theme !== 'string' || !(ROGUELIKE_THEMES as readonly string[]).includes(params.theme))) {
    return `${prefix}.params.theme 必须是 ${ROGUELIKE_THEMES.join('、')} 之一`;
  }
  const theme = typeof params.theme === 'string' ? params.theme : 'Phantom';

  if (params.mode !== undefined && !isIntegerValue(params.mode)) {
    return `${prefix}.params.mode 必须是整数`;
  }
  const mode = isIntegerValue(params.mode) ? params.mode : 0;
  const allowedModes = ROGUELIKE_MODES_BY_THEME[theme] ?? [];
  if (!allowedModes.includes(mode)) {
    return `${prefix}.params.mode ${mode} 不适用于 ${theme} 主题，可选：${allowedModes.join('、')}`;
  }

  for (const field of ROGUELIKE_BOOLEAN_FIELDS) {
    if (params[field] !== undefined && typeof params[field] !== 'boolean') {
      return `${prefix}.params.${field} 必须是布尔值`;
    }
  }
  for (const field of ROGUELIKE_STRING_FIELDS) {
    if (params[field] !== undefined && typeof params[field] !== 'string') {
      return `${prefix}.params.${field} 必须是字符串`;
    }
  }
  for (const field of ROGUELIKE_INTEGER_FIELDS) {
    if (params[field] !== undefined && !isIntegerValue(params[field])) {
      return `${prefix}.params.${field} 必须是整数`;
    }
  }
  for (const field of ROGUELIKE_STRING_ARRAY_FIELDS) {
    if (params[field] === undefined) continue;
    const error = validateRoguelikeStringArrayField(prefix, field, params[field]);
    if (error) return error;
  }

  if (params.core_char_list !== undefined) {
    const error = validateRoguelikeCoreCharList(params.core_char_list, prefix);
    if (error) return error;
  }
  if (params.collectible_mode_start_list !== undefined) {
    const error = validateRoguelikeBlackflowStartList(params.collectible_mode_start_list, prefix);
    if (error) return error;
  }
  if (params.blackflow_strategy !== undefined
    && !(ROGUELIKE_BLACKFLOW_STRATEGIES as readonly string[]).includes(String(params.blackflow_strategy))) {
    return `${prefix}.params.blackflow_strategy 必须是 ${ROGUELIKE_BLACKFLOW_STRATEGIES.join('、')} 之一`;
  }
  if (params.blackflow_cultivation_target !== undefined
    && !(ROGUELIKE_BLACKFLOW_CULTIVATION_TARGETS as readonly string[]).includes(String(params.blackflow_cultivation_target))) {
    return `${prefix}.params.blackflow_cultivation_target 必须是 ${ROGUELIKE_BLACKFLOW_CULTIVATION_TARGETS.join('、')} 之一`;
  }

  if (params.only_start_with_elite_two === true && params.start_with_elite_two !== true) {
    return `${prefix}.params.only_start_with_elite_two 只能与 start_with_elite_two 同时使用`;
  }
  if (mode !== 4 && (params.start_with_elite_two === true || params.only_start_with_elite_two === true)) {
    return `${prefix}.params.start_with_elite_two 仅在 mode 4 下可用`;
  }

  if (params.find_playTime_target !== undefined) {
    const target = params.find_playTime_target;
    if (!isIntegerValue(target) || target < 1 || target > 3) {
      return `${prefix}.params.find_playTime_target 必须是 1、2 或 3`;
    }
  }
  if (mode === 20001 && params.find_playTime_target === undefined) {
    return `${prefix}.params.find_playTime_target 在 mode 20001 下必填`;
  }

  if (mode === 30003 && params.blackflow_start_animals === undefined) {
    return `${prefix}.params.blackflow_start_animals 在 mode 30003 下必填`;
  }
  if (params.blackflow_start_animals !== undefined) {
    const error = validateRoguelikeBlackflowAnimals(params.blackflow_start_animals, prefix);
    if (error) return error;
  }
  if (mode === 30003 && params.blackflow_start_rewards === undefined) {
    return `${prefix}.params.blackflow_start_rewards 在 mode 30003 下必填`;
  }
  if (params.blackflow_start_rewards !== undefined) {
    const rewards = params.blackflow_start_rewards;
    if (!isIntegerValue(rewards) || rewards < 0 || rewards > 0xFFF) {
      return `${prefix}.params.blackflow_start_rewards 必须是 0 至 4095 的整数`;
    }
  }
  if (params.blackflow_start_utopia === true) {
    const error = validateRoguelikeBlackflowStartRewardPriority(params.blackflow_start_reward_priority, prefix);
    if (error) return error;
  }

  return null;
}

function validateReclamationParams(params: Record<string, unknown>): string | null {
  const prefix = 'Reclamation';

  if (params.theme !== undefined
    && (typeof params.theme !== 'string' || !(RECLAMATION_THEMES as readonly string[]).includes(params.theme))) {
    return `${prefix}.params.theme 必须是 ${RECLAMATION_THEMES.join('、')} 之一`;
  }
  const theme = typeof params.theme === 'string' ? params.theme : 'Tales';

  if (params.mode !== undefined && !isIntegerValue(params.mode)) {
    return `${prefix}.params.mode 必须是整数`;
  }
  const allowedModes = RECLAMATION_MODES_BY_THEME[theme] ?? [];
  if (typeof params.mode !== 'number') {
    if (theme !== 'Tales') {
      return `${prefix}.params.mode 在 ${theme} 主题下必填，可选：${allowedModes.join('、')}`;
    }
  } else if (!allowedModes.includes(params.mode)) {
    return `${prefix}.params.mode ${params.mode} 不适用于 ${theme} 主题，可选：${allowedModes.join('、')}`;
  }

  if (params.clear_store !== undefined && typeof params.clear_store !== 'boolean') {
    return `${prefix}.params.clear_store 必须是布尔值`;
  }
  if (params.tools_to_craft !== undefined
    && (!isStringArrayValue(params.tools_to_craft)
      || params.tools_to_craft.some(tool => !tool.trim()))) {
    return `${prefix}.params.tools_to_craft 必须是非空工具名数组`;
  }
  if (params.increment_mode !== undefined
    && (!isIntegerValue(params.increment_mode) || (params.increment_mode !== 0 && params.increment_mode !== 1))) {
    return `${prefix}.params.increment_mode 必须是 0 或 1`;
  }
  if (params.num_craft_batches !== undefined
    && (!isIntegerValue(params.num_craft_batches) || params.num_craft_batches < 1)) {
    return `${prefix}.params.num_craft_batches 必须是正整数`;
  }
  return null;
}

const CLI_ROGUELIKE_THEMES = Object.freeze(['Phantom', 'Mizuki', 'Sami', 'Sarkaz', 'JieGarden'] as const);
const CLI_ROGUELIKE_MODES = Object.freeze([0, 1, 4, 5, 6, 7] as const);
const CLI_RECLAMATION_THEMES = Object.freeze(['Tales'] as const);
const CLI_ROGUELIKE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  'mode', 'difficulty', 'squad', 'roles', 'core-char', 'starts-count', 'start-count',
  'investments-count', 'start-foldartals', 'expected-collapsal-paradigms', 'start-with-seed'
]);
const CLI_RECLAMATION_VALUE_FLAGS: ReadonlySet<string> = new Set([
  'mode', 'tools-to-craft', 'increment-mode', 'increase-mode', 'num-craft-batches'
]);
const CLI_ROGUELIKE_SHORT_FLAGS = Object.freeze(['-F', '-P'] as const);
const CLI_RECLAMATION_SHORT_FLAGS = Object.freeze(['-m', '-C'] as const);

interface ParsedCommandArgs {
  theme: string | null;
  values: Map<string, string[]>;
}

function pushCommandValue(values: Map<string, string[]>, name: string, value: string | undefined): void {
  if (value === undefined) return;
  const entries = values.get(name);
  if (entries) entries.push(value);
  else values.set(name, [value]);
}

/** 只解析已知的带值参数与首个位置参数；未知参数保持透传，交给 maa-cli 自身报错。 */
function parseCommandArgs(args: readonly string[], valueFlags: ReadonlySet<string>): ParsedCommandArgs {
  const values = new Map<string, string[]>();
  let theme: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? '';
    if (token === '--') {
      if (theme === null) theme = args[index + 1] ?? null;
      break;
    }
    if (token.startsWith('--')) {
      const separator = token.indexOf('=');
      const name = separator >= 0 ? token.slice(2, separator) : token.slice(2);
      if (!valueFlags.has(name)) continue;
      if (separator >= 0) {
        pushCommandValue(values, name, token.slice(separator + 1));
        continue;
      }
      pushCommandValue(values, name, args[index + 1]);
      index += 1;
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      const name = token.slice(0, 2);
      if (!CLI_ROGUELIKE_SHORT_FLAGS.includes(name as '-F' | '-P')
        && !CLI_RECLAMATION_SHORT_FLAGS.includes(name as '-m' | '-C')) {
        continue;
      }
      const inline = token.slice(2);
      if (inline) {
        pushCommandValue(values, name, inline);
        continue;
      }
      pushCommandValue(values, name, args[index + 1]);
      index += 1;
      continue;
    }
    if (theme === null) theme = token;
  }

  return { theme, values };
}

function lastCommandValue(values: Map<string, string[]>, name: string): string | undefined {
  return values.get(name)?.at(-1);
}

function isCommandInteger(value: string | undefined): number | null {
  if (value === undefined || !/^[+-]?\d+$/.test(value.trim())) return null;
  return Number(value);
}

/**
 * 预检 maa-cli 的 `roguelike` / `reclamation` 参数：主题必须是该 CLI 支持的代号，
 * 模式必须落在 CLI 的取值范围内。Core 新增的主题与模式只能通过动态任务下发，
 * 这里返回明确错误而不是把参数静默透传给 CLI。
 */
export function validateRoguelikeCommandArgs(command: string, args: readonly string[]): string | null {
  if (command !== 'roguelike' && command !== 'reclamation') return null;

  if (command === 'reclamation') {
    const { theme, values } = parseCommandArgs(args, CLI_RECLAMATION_VALUE_FLAGS);
    const normalizedTheme = theme?.trim() ?? '';
    if (normalizedTheme && !(CLI_RECLAMATION_THEMES as readonly string[]).includes(normalizedTheme)) {
      return `maa-cli 的生息演算只支持 ${CLI_RECLAMATION_THEMES.join('、')} 主题；「${normalizedTheme}」请改用 command=run 加 taskConfig 动态任务`;
    }
    const mode = lastCommandValue(values, 'mode') ?? lastCommandValue(values, '-m');
    if (mode !== undefined && lastCommandValue(values, '-m') === undefined && !values.has('mode')) {
      return null;
    }
    const modeValue = mode;
    if (modeValue !== undefined) {
      const parsed = isCommandInteger(modeValue);
      if (parsed === null || (parsed !== 0 && parsed !== 1)) {
        return '生息演算 --mode 必须是 0 或 1';
      }
    }
    const increment = lastCommandValue(values, 'increment-mode') ?? lastCommandValue(values, 'increase-mode');
    if (increment !== undefined) {
      const parsed = isCommandInteger(increment);
      if (parsed !== 0 && parsed !== 1) return '生息演算 --increment-mode 必须是 0 或 1';
    }
    const batches = lastCommandValue(values, 'num-craft-batches');
    if (batches !== undefined) {
      const parsed = isCommandInteger(batches);
      if (parsed === null || parsed < 1) return '生息演算 --num-craft-batches 必须是正整数';
    }
    for (const tool of values.get('tools-to-craft') ?? []) {
      if (!tool.trim()) return '生息演算 --tools-to-craft 不能为空白工具名';
    }
    for (const tool of values.get('-C') ?? []) {
      if (!tool.trim()) return '生息演算 -C 不能为空白工具名';
    }
    return null;
  }

  const { theme, values } = parseCommandArgs(args, CLI_ROGUELIKE_VALUE_FLAGS);
  const normalizedTheme = theme?.trim() ?? '';
  if (normalizedTheme) {
    if (normalizedTheme === 'BlackFlow') {
      return 'maa-cli 0.7.8 不支持主题「BlackFlow」，请改用 command=run 加 taskConfig 动态任务';
    }
    if (!(CLI_ROGUELIKE_THEMES as readonly string[]).includes(normalizedTheme)) {
      return `集成战略主题必须是 ${CLI_ROGUELIKE_THEMES.join('、')} 之一；「${normalizedTheme}」请改用 command=run 加 taskConfig 动态任务`;
    }
  }

  const modeValue = lastCommandValue(values, 'mode');
  let mode: number | null = null;
  if (modeValue !== undefined) {
    mode = isCommandInteger(modeValue);
    if (mode === null) return '集成战略 --mode 必须是整数';
    if ([10001, 20001, 30001, 30003].includes(mode)) {
      return `maa-cli 0.7.8 不支持 --mode ${mode}，请改用 command=run 加 taskConfig 动态任务`;
    }
    if (!(CLI_ROGUELIKE_MODES as readonly number[]).includes(mode)) {
      return '集成战略 --mode 必须是 0、1、4、5、6 或 7';
    }
    if (mode === 5 && normalizedTheme && normalizedTheme !== 'Sami') {
      return '集成战略模式 5 仅支持萨米（Sami）主题';
    }
  }

  for (const field of ['starts-count', 'start-count', 'investments-count', 'difficulty'] as const) {
    const value = lastCommandValue(values, field);
    if (value === undefined) continue;
    if (isCommandInteger(value) === null) return `集成战略 --${field} 必须是整数`;
  }
  for (const field of ['start-foldartals', 'expected-collapsal-paradigms', 'start-with-seed'] as const) {
    if ((values.get(field) ?? []).some(value => !value.trim())) {
      return `集成战略 --${field} 不能为空白值`;
    }
  }
  for (const field of ['-F', '-P'] as const) {
    if ((values.get(field) ?? []).some(value => !value.trim())) {
      return `集成战略 ${field} 不能为空白值`;
    }
  }
  return null;
}
