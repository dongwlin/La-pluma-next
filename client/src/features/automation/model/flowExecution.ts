/**
 * 自动化流程执行投影
 *
 * 流程列表、任务编辑面板与执行摘要都只读取服务端 Run 投影，不维护第二套
 * 运行状态。本模块把「最近一次摘要、逐项结果、当前步骤、单项展示状态」
 * 从页面移到纯函数，便于脱离 React 验证：
 * - 活动期只读 `progress.taskResults`，提交在途不展示旧结果；
 * - 空闲时回退到服务端流程投影的最近执行摘要；
 * - 终态摘要缺失逐项结果时，按动作/错误名称映射回流程位置；
 * - 未启用的任务始终是 `idle`，结果行中的 `running` 在 run 结束后显示为
 *   `stopped`，不把中断当成完成。
 */

import type { TaskFlowItem } from '../types'
import {
  resolveExecutionStep,
  taskResultsFromSummary,
  type TaskExecutionResult,
  type TaskExecutionState,
} from '../utils/automationTaskProgress'

/** 单项展示状态：`idle` 表示未启用或本次没有该任务的执行结果。 */
export type FlowTaskExecutionState = TaskExecutionState | 'idle'

/** `taskResultsFromSummary` 需要的摘要形状；完整摘要与流程投影都满足。 */
export interface FlowSummaryInput {
  taskResults?: TaskExecutionResult[]
  actions?: Array<{ task: string; status: 'success' | 'failed' | 'skipped' }>
  errors?: Array<string | { task: string; error: string }>
}

export interface FlowTaskExecutionView {
  isRunning: boolean
  taskResults: TaskExecutionResult[]
  currentStep: number
}

export interface FlowDisplaySummaryInput<T> {
  summary: T | null
  scheduleSummary: T | null
  isRunning: boolean
  isSubmitting: boolean
}

/**
 * 选择“最近执行”的来源：本页持有 run 的终态摘要优先；空闲且没有提交在途时
 * 回退到服务端流程投影；运行中或提交在途不展示旧摘要。
 */
export function selectFlowDisplaySummary<T>({
  summary,
  scheduleSummary,
  isRunning,
  isSubmitting,
}: FlowDisplaySummaryInput<T>): T | null {
  if (summary) return summary
  return !isRunning && !isSubmitting ? scheduleSummary : null
}

interface FlowTaskResultsInput {
  isRunning: boolean
  isSubmitting: boolean
  progress: { taskResults: TaskExecutionResult[] } | null
  displaySummary: FlowSummaryInput | null
}

/** 逐项结果的唯一来源：活动期读 Run 进度，空闲期读终态摘要。 */
export function selectFlowTaskResults(
  tasks: TaskFlowItem[],
  { isRunning, isSubmitting, progress, displaySummary }: FlowTaskResultsInput,
): TaskExecutionResult[] {
  if (isRunning) return progress?.taskResults ?? []
  if (isSubmitting) return []
  return displaySummary ? taskResultsFromSummary(displaySummary, tasks) : []
}

/** 当前执行位置按任务 ID 映射回真实流程索引；非运行态返回 -1。 */
export function selectFlowCurrentStep(
  tasks: TaskFlowItem[],
  progress: { currentStep: number | null; currentTaskId: string | null } | null,
  isRunning: boolean,
): number {
  return isRunning && progress ? resolveExecutionStep(tasks, progress) : -1
}

/**
 * 计算单项展示状态。优先采用服务端逐项结果；没有结果时才按当前步骤推断，
 * 避免在流程步间延迟期间提前把任务标成完成。
 */
export function resolveFlowTaskExecutionState(
  task: TaskFlowItem,
  index: number,
  view: FlowTaskExecutionView,
): FlowTaskExecutionState {
  if (!task.enabled) return 'idle'
  const result = view.taskResults.find(entry => entry.taskId === task.id)
  if (result) return result.status === 'running' && !view.isRunning ? 'stopped' : result.status
  if (!view.isRunning) return 'idle'
  return view.currentStep === index ? 'running' : view.currentStep > index ? 'success' : 'pending'
}

const TASK_EXECUTION_LABELS: Record<FlowTaskExecutionState, string> = {
  idle: '',
  pending: '等待执行',
  running: '正在执行',
  success: '已完成',
  failed: '执行失败',
  skipped: '已跳过',
  stopped: '已终止',
}

/** 单项状态文案；空闲态由调用方回退到任务描述。 */
export function describeFlowTaskExecutionState(
  state: FlowTaskExecutionState,
  isRunning: boolean,
): string {
  if (state === 'pending' && !isRunning) return '未执行'
  return TASK_EXECUTION_LABELS[state]
}
