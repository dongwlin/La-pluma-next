import type { OperatorRecognitionSummary } from '../types'

export interface TrainingRecognitionHint {
  tone: 'info' | 'warning'
  message: string
}

/**
 * 候选列表上方的识别完整度提示。完整识别不占位；旧服务端没有识别概要时
 * 保持静默，不能把缺字段误判成“尚未识别”。
 */
export const describeRecognitionHint = (
  recognition: OperatorRecognitionSummary | null,
): TrainingRecognitionHint | null => {
  if (!recognition) return null

  if (recognition.status === 'missing') {
    return {
      tone: 'info',
      message: '尚未识别干员：未拥有状态未知，请先在“数据统计”完成一次干员识别。',
    }
  }

  if (recognition.status === 'partial') {
    return {
      tone: 'warning',
      message: recognition.unknown > 0
        ? `识别不完整：${recognition.unknown} 名干员的拥有状态未确认，列表中按“未识别”显示。`
        : '识别不完整：部分干员的拥有状态未确认，列表中按“未识别”显示。',
    }
  }

  return null
}
