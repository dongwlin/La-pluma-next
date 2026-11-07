import type { TaskParamField, TaskParamFieldType } from '../types'

const TOOLTIP_HELPER_FIELD_TYPES: ReadonlySet<TaskParamFieldType> = new Set([
  'checkbox',
  'select',
  'text',
  'number',
])

export function resolveFieldHelperTooltip(field: TaskParamField): string | undefined {
  if (!field.helper || field.helperPlacement !== 'tooltip') return undefined
  return TOOLTIP_HELPER_FIELD_TYPES.has(field.type) ? field.helper : undefined
}
