/**
 * 统计识别与材料刷新命令的页面投影
 *
 * 命令生命周期仍由模块级 `statisticsCommandOwner` 持有；本 hook 只把
 * 同一份状态投影给工作区和面板，并把解析成功后的权威快照写回唯一 Query：
 * - 识别成功先取消在途读取、写 `game-data` 的 `depot`/`operbox` key，再由
 *   所有者发布跨域失效，避免自失效触发的 GET 覆盖刚解析出的快照；
 * - busy/idle 等非终态结果只转成全局提示，不复制命令状态；
 * - 超时/取消后的按钮继续等待或重试确认，不会重新执行设备命令。
 */

import { useQueryClient } from '@tanstack/react-query'
import { gameDataKeys } from '@/features/game-data'
import { useStatusStore } from '@/features/runtime-status'
import {
  isStatisticsCommandRunning,
  statisticsCommandOwner,
  type StatisticsCommandKind,
  type StatisticsCommandResult,
  type StatisticsRecognitionKind,
  type StatisticsRecognitionSnapshot,
} from '../model/commandOwner'
import { useStatisticsCommandState } from './useStatisticsCommand'
import type { ActiveTask } from '../types'

export interface StatisticsCommands {
  isRunning: boolean
  /** 正在识别仓库/干员时的任务名；其他命令或空闲时为 null。 */
  activeTask: ActiveTask
  activeKind: StatisticsCommandKind | null
  /** 识别按钮文案：立即执行 / 继续解析 / 重试识别。 */
  actionLabel: (kind: StatisticsRecognitionKind) => string
  startRecognition: (kind: StatisticsRecognitionKind) => void
  fetchMaterials: () => void
}

export function useStatisticsCommands(): StatisticsCommands {
  const commandState = useStatisticsCommandState()
  const setMessage = useStatusStore(state => state.setMessage)
  const queryClient = useQueryClient()
  const isRunning = isStatisticsCommandRunning(commandState)

  // 解析结果是权威完整快照：先取消该 key 的在途读取，再写入唯一 Query 缓存。
  // 命令所有者会在这之后才发布失效，监听器看到的是刚写入的新快照。
  const applyRecognitionSnapshot = async (snapshot: StatisticsRecognitionSnapshot) => {
    const key = snapshot.kind === 'depot'
      ? gameDataKeys.resource('depot')
      : gameDataKeys.resource('operbox')
    await queryClient.cancelQueries({ queryKey: key })
    queryClient.setQueryData(
      key,
      snapshot.kind === 'depot' ? snapshot.depot : snapshot.operBox,
    )
  }

  const applyCommandResult = (result: StatisticsCommandResult) => {
    if (result.status === 'busy' || result.status === 'idle') {
      setMessage(result.message)
    }
  }

  const progressOptions = {
    onProgress: setMessage,
    applyRecognitionSnapshot,
  }

  const runRecognition = async (kind: StatisticsRecognitionKind) => {
    applyCommandResult(await statisticsCommandOwner.run(kind, progressOptions))
  }

  const continueRecognition = async () => {
    applyCommandResult(await statisticsCommandOwner.resume(progressOptions))
  }

  // 同一命令的超时/取消之后，按钮继续等待或重试确认；不会重新执行设备命令。
  const startRecognition = (kind: StatisticsRecognitionKind) => {
    if (commandState.kind === kind && commandState.resumeMode) {
      void continueRecognition()
      return
    }
    void runRecognition(kind)
  }

  const actionLabel = (kind: StatisticsRecognitionKind) => {
    if (isRunning || commandState.kind !== kind || !commandState.resumeMode) return '立即执行'
    return commandState.resumeMode === 'parse' ? '继续解析' : '重试识别'
  }

  // 材料刷新是统计域持有的脚本命令，不进入 Query，也不读一次目录当作完成条件。
  const fetchMaterials = () => {
    void (async () => {
      applyCommandResult(await statisticsCommandOwner.run('materials', progressOptions))
    })()
  }

  const activeTask: ActiveTask =
    isRunning && (commandState.kind === 'depot' || commandState.kind === 'operbox')
      ? commandState.kind
      : null

  return {
    isRunning,
    activeTask,
    activeKind: commandState.kind,
    actionLabel,
    startRecognition,
    fetchMaterials,
  }
}
