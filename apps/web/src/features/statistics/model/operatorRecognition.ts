import type { OperBoxRecognitionInfo } from '@/features/game-data'

/**
 * 统计页的识别完整度提示：完整识别不占位；旧快照（没有识别目录）只确认
 * 已识别拥有的干员，未列出的干员不能按“未拥有”展示。
 */
export const describeOperBoxRecognitionHint = (
  recognition: OperBoxRecognitionInfo | undefined,
): string | null => {
  if (!recognition || recognition.status === 'complete') return null
  return '识别快照缺少完整干员目录：未列出的干员拥有状态尚未确认，重新识别后可确认。'
}
