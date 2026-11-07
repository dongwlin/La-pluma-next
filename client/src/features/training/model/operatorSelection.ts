import type { OperatorDetailed } from '@/features/game-data'
import type { OperatorPickerOption } from '../types'

/** 把识别快照或全量目录条目归一为选择器行；缺失的可选字段保持省略。 */
export const toOperatorPickerOption = (operator: OperatorDetailed): OperatorPickerOption => ({
  id: operator.id,
  name: operator.name,
  rarity: operator.rarity,
  ...(operator.profession ? { profession: operator.profession } : {}),
  ...(typeof operator.elite === 'number' ? { elite: operator.elite } : {}),
  ...(typeof operator.level === 'number' ? { level: operator.level } : {}),
})
