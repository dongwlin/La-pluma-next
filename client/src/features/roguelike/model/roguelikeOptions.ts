/**
 * 肉鸽策略字段表与主题相关选项
 *
 * 字段表只描述 CLI 参数与适用条件：`themes`/`modes`/`requires` 决定字段是否生效，
 * `choices` 标识取值随主题变化的选项表。命令构造、可见性与校验都读取同一份表，
 * 面板只负责渲染，不复制参数语义与候选列表。
 */

import type {
  RoguelikeAdvancedOption,
  RoguelikeSelectOption,
} from '../types'

const DEFAULT_SQUAD: RoguelikeSelectOption = { value: '', label: '默认（指挥分队）' }

/** 各主题共有的通用分队；顺序沿用上游 GUI。 */
const COMMON_SQUADS: readonly string[] = [
  '指挥分队',
  '后勤分队',
  '突击战术分队',
  '堡垒战术分队',
  '远程战术分队',
  '破坏战术分队',
]

/** 主题专属分队；不含通用分队与高规格分队。 */
const THEME_SQUADS: Record<string, readonly string[]> = {
  Phantom: ['集群分队', '矛头分队', '研究分队'],
  Mizuki: ['集群分队', '矛头分队', '心胜于物分队', '物尽其用分队', '以人为本分队', '研究分队'],
  Sami: ['集群分队', '矛头分队', '永恒狩猎分队', '生活至上分队', '科学主义分队', '特训分队'],
  Sarkaz: [
    '集群分队',
    '矛头分队',
    '魂灵护送分队',
    '博闻广记分队',
    '蓝图测绘分队',
    '因地制宜分队',
    '异想天开分队',
    '点刺成锭分队',
    '拟态学者分队',
    '专业人士分队',
  ],
  JieGarden: [
    '特勤分队',
    '高台突破分队',
    '地面突破分队',
    '游客分队',
    '司岁台分队',
    '天师府分队',
    '花团锦簇分队',
    '棋行险着分队',
    '岁影回音分队',
    '知学分队',
    '商贾分队',
  ],
}

const SLOW_AND_STEADY: RoguelikeSelectOption = { value: '稳扎稳打', label: '稳扎稳打（重装、术师、狙击）' }
const FIRST_MOVE_ADVANTAGE: RoguelikeSelectOption = { value: '先手必胜', label: '先手必胜（先锋、狙击、特种）' }
const OVERCOMING_WEAKNESSES: RoguelikeSelectOption = { value: '取长补短', label: '取长补短（近卫、辅助、医疗）' }
const FLEXIBLE_DEPLOYMENT: RoguelikeSelectOption = { value: '灵活部署', label: '灵活部署（先锋、辅助、特种）' }
const UNBREAKABLE: RoguelikeSelectOption = { value: '坚不可摧', label: '坚不可摧（重装、术师、医疗）' }
const AS_YOUR_HEART_DESIRES: RoguelikeSelectOption = { value: '随心所欲', label: '随心所欲（三张随机）' }

/** 主题允许的数值难度上限；傀影没有数值难度，不在表内。 */
const THEME_MAX_DIFFICULTY: Record<string, number> = {
  Mizuki: 18,
  Sami: 15,
  Sarkaz: 18,
  JieGarden: 18,
}

const NUMERIC_DIFFICULTY_THEMES: readonly string[] = ['Mizuki', 'Sami', 'Sarkaz', 'JieGarden']

const BASE_MODES: readonly RoguelikeSelectOption[] = [
  { value: '0', label: '刷分模式' },
  { value: '1', label: '刷源石锭' },
  { value: '4', label: '刷开局' },
]

const BASE_ROLES: readonly RoguelikeSelectOption[] = [
  SLOW_AND_STEADY,
  FIRST_MOVE_ADVANTAGE,
  OVERCOMING_WEAKNESSES,
]

function squadChoices(theme: string): RoguelikeSelectOption[] {
  const names = [...(THEME_SQUADS[theme] ?? []), ...COMMON_SQUADS, '高规格分队']
  const seen = new Set<string>()
  const squads = names.filter(name => {
    if (seen.has(name)) return false
    seen.add(name)
    return true
  })
  return [DEFAULT_SQUAD, ...squads.map(name => ({ value: name, label: name }))]
}

function roleChoices(theme: string): RoguelikeSelectOption[] {
  const extra = theme === 'JieGarden' ? [FLEXIBLE_DEPLOYMENT, UNBREAKABLE] : []
  return [...BASE_ROLES, ...extra, AS_YOUR_HEART_DESIRES]
}

function modeChoices(theme: string): RoguelikeSelectOption[] {
  if (theme !== 'Sami') return [...BASE_MODES]
  return [...BASE_MODES, { value: '5', label: '刷坍缩范式' }]
}

function difficultyChoices(theme: string): RoguelikeSelectOption[] {
  const max = THEME_MAX_DIFFICULTY[theme] ?? 15
  const choices: RoguelikeSelectOption[] = [{ value: '-1', label: '不切换（沿用游戏内难度）' }]
  for (let level = max; level >= 1; level -= 1) {
    choices.push({ value: String(level), label: String(level) })
  }
  choices.push({ value: '0', label: '0（最低）' })
  return choices
}

const ROGUELIKE_OPTIONS: readonly RoguelikeAdvancedOption[] = [
  { key: 'mode', label: '模式', type: 'select', param: '--mode', choices: 'modes' },
  {
    key: 'difficulty',
    label: '难度',
    type: 'select',
    param: '--difficulty',
    choices: 'difficulty',
    themes: NUMERIC_DIFFICULTY_THEMES,
    hint: '不切换时沿用游戏内当前难度；指定未解锁的难度会被降到已解锁上限。',
  },
  { key: 'squad', label: '起始分队', type: 'select', param: '--squad', choices: 'squads' },
  {
    key: 'roles',
    label: '开局职业组',
    type: 'select',
    param: '--roles',
    choices: 'roles',
    defaultValue: '稳扎稳打',
    hint: '决定开局能招募的职业；核心干员的职业必须在组合内，例如维什戴尔（狙击）需要稳扎稳打。',
  },
  {
    key: 'coreChar',
    label: '核心干员',
    type: 'text',
    param: '--core-char',
    placeholder: '维什戴尔',
    hint: '填写单个干员中文名；留空由 MAA 按练度自动选择。',
  },
  { key: 'startCount', label: '运行次数', type: 'number', param: '--start-count', placeholder: '无限' },
  {
    key: 'investmentsCount',
    label: '投资次数',
    type: 'number',
    param: '--investments-count',
    placeholder: '不限',
    requires: { key: 'disableInvestment', equals: false },
  },
  {
    key: 'startFoldartals',
    label: '凹开局密文板',
    type: 'list',
    param: '--start-foldartals',
    placeholder: '英雄，大地',
    themes: ['Sami'],
    hint: '多个用逗号分隔；仅生活至上分队凹开局板子时生效。',
  },
  {
    key: 'expectedCollapsalParadigms',
    label: '期望坍缩范式',
    type: 'list',
    param: '--expected-collapsal-paradigms',
    placeholder: '目空一些，图像损坏',
    themes: ['Sami'],
    modes: ['5'],
    hint: '多个用逗号分隔；刷坍缩范式模式必填。',
  },
  {
    key: 'useSupport',
    label: '使用助战',
    type: 'checkbox',
    param: '--use-support',
    hint: '只作用于核心干员；需要好友提供该干员。',
  },
  {
    key: 'useNonfriendSupport',
    label: '可使用非好友助战',
    type: 'checkbox',
    param: '--use-nonfriend-support',
    requires: { key: 'useSupport' },
  },
  {
    key: 'disableInvestment',
    label: '禁用投资',
    type: 'checkbox',
    param: '--disable-investment',
    hint: '默认会投资源石锭；勾选后不投资。',
  },
  {
    key: 'investmentWithMoreScore',
    label: '投资时多刷分',
    type: 'checkbox',
    param: '--investment-with-more-score',
    requires: { key: 'disableInvestment', equals: false },
  },
  {
    key: 'noStopWhenInvestmentFull',
    label: '投资满后继续',
    type: 'checkbox',
    param: '--no-stop-when-investment-full',
    requires: { key: 'disableInvestment', equals: false },
  },
  {
    key: 'startWithEliteTwo',
    label: '凹开局直升',
    type: 'checkbox',
    param: '--start-with-elite-two',
    modes: ['4'],
  },
  {
    key: 'onlyStartWithEliteTwo',
    label: '只凹直升不作战',
    type: 'checkbox',
    param: '--only-start-with-elite-two',
    modes: ['4'],
    requires: { key: 'startWithEliteTwo' },
  },
  {
    key: 'stopAtBoss',
    label: '最终 Boss 前停止',
    type: 'checkbox',
    param: '--stop-at-final-boss',
    modes: ['0'],
    themes: NUMERIC_DIFFICULTY_THEMES,
  },
  {
    key: 'refreshTraderWithDice',
    label: '刷新商店（指路鳞）',
    type: 'checkbox',
    param: '--refresh-trader-with-dice',
    themes: ['Mizuki'],
  },
  {
    key: 'useFoldartal',
    label: '使用密文板',
    type: 'checkbox',
    param: '--use-foldartal',
    themes: ['Sami'],
  },
  {
    key: 'startWithSeed',
    label: '种子开局',
    type: 'checkbox',
    param: '--start-with-seed',
    themes: ['Sarkaz'],
    modes: ['1'],
    hint: '仅刷源石锭模式；沿用游戏内当前种子。',
  },
]

const RECLAMATION_OPTIONS: readonly RoguelikeAdvancedOption[] = [
  {
    key: 'mode',
    label: '模式',
    type: 'select',
    param: '-m',
    options: [
      { value: '0', label: '刷繁荣度（无存档）' },
      { value: '1', label: '制作工具刷繁荣度' },
    ],
    defaultValue: '1',
    hint: '模式 0 仅在没有存档时使用（有存档可能丢失进度），需在主界面右下角出现「开始演算」后启动；模式 1 需要已有存档，需在能看到驻扎地的页面启动，建议从新的计算日启动。',
  },
  { key: 'toolsToCraft', label: '制作工具名称', type: 'text', param: '-C', placeholder: '荧光棒' },
  { key: 'numBatches', label: '批次数', type: 'number', param: '--num-craft-batches', placeholder: '16' },
]

const OPTION_TABLES: Record<string, readonly RoguelikeAdvancedOption[]> = {
  roguelike: ROGUELIKE_OPTIONS,
  reclamation: RECLAMATION_OPTIONS,
}

export function getRoguelikeAdvancedOptions(taskId: string): RoguelikeAdvancedOption[] {
  return [...(OPTION_TABLES[taskId] ?? [])]
}

/**
 * 字段的实际下拉项：主题相关的 select 由 choices 解析，其余沿用静态 options。
 * 未知主题按最保守的通用列表处理。
 */
export function getRoguelikeOptionChoices(
  option: RoguelikeAdvancedOption,
  theme: string,
): RoguelikeSelectOption[] | undefined {
  switch (option.choices) {
    case 'modes':
      return modeChoices(theme)
    case 'difficulty':
      return difficultyChoices(theme)
    case 'squads':
      return squadChoices(theme)
    case 'roles':
      return roleChoices(theme)
    default:
      return option.options
  }
}
