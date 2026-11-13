import { OPER_PROGRESS_ROLES } from './gameTaskParams'
import type { GameTaskDeferredMastery, GameTaskDetail } from './automationRun'

const RESULT_DETAIL_LABELS: Readonly<Record<string, string>> = {
  ResourceInsufficient: '材料不足',
  OperatorNotFound: '未找到干员',
  TrainingRoomBusy: '训练室已被占用',
  PrerequisiteTraining: '已启动前置专精训练',
  AlreadySatisfied: '已达到目标',
  Completed: '已完成',
  PrerequisiteNotMet: '前置条件未满足',
  ChipNotCraftable: '无法合成芯片',
  FormulaLocked: '配方未解锁',
  RecognitionFailed: '识别失败',
  Unsupported: '不支持的计划',
  Interrupt: '已中断',
}

const RESULT_LABELS: Readonly<Record<GameTaskDetail['result'], string>> = {
  Success: '培养成功',
  Failed: '培养失败',
  Skipped: '已跳过',
}

const ELITE_LABELS: Readonly<Record<number, string>> = {
  1: '精英一',
  2: '精英二',
}

export function gameTaskRoleLabel(role?: string): string | undefined {
  if (!role || role === 'Unknown') return undefined
  return OPER_PROGRESS_ROLES.find(option => option.value === role)?.label ?? role
}

export function gameTaskResultDetailLabel(
  resultDetail: string,
  skillMastery?: readonly number[],
): string | undefined {
  if (!resultDetail) return undefined
  if (resultDetail === 'Completed' && skillMastery?.some(level => level > 0)) {
    return '已启动目标专精训练，等待完成'
  }
  return RESULT_DETAIL_LABELS[resultDetail] ?? resultDetail
}

export function gameTaskResultLabel(result: GameTaskDetail['result']): string {
  return RESULT_LABELS[result]
}

function operatorLabel(name: string, role?: string): string {
  const label = gameTaskRoleLabel(role)
  return label ? `${name}（${label}）` : name
}

function masteryTargetLabels(mastery: [number, number, number] | undefined): string[] {
  if (!mastery) return []
  return mastery.flatMap((level, index) => level > 0 ? [`专精 S${index + 1} Lv${level}`] : [])
}

function targetSummary(target: {
  elite?: number
  skillLevel?: number
  skillMastery?: [number, number, number]
}): string | undefined {
  const labels = [
    target.elite === undefined ? undefined : ELITE_LABELS[target.elite],
    target.skillLevel === undefined ? undefined : `技能 ${target.skillLevel}`,
    ...masteryTargetLabels(target.skillMastery),
  ].filter((label): label is string => Boolean(label))
  return labels.length > 0 ? labels.join(' / ') : undefined
}

export function describeGameTaskDetail(detail: GameTaskDetail): string {
  return [
    `${operatorLabel(detail.name, detail.role)}：${gameTaskResultLabel(detail.result)}`,
    gameTaskResultDetailLabel(detail.resultDetail, detail.skillMastery),
    targetSummary(detail),
  ].filter((part): part is string => Boolean(part)).join(' · ')
}

export function describeDeferredMastery(entry: GameTaskDeferredMastery): string {
  return [
    `${operatorLabel(entry.name, entry.role)}：专精目标待处理，训练室占用，需后续运行`,
    targetSummary({ skillMastery: entry.skillMastery }),
  ].filter((part): part is string => Boolean(part)).join(' · ')
}
