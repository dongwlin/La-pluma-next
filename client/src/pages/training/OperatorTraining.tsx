/**
 * 养成页
 *
 * 页面只组合养成工作区；队列、设置与计划的读取/提交、候选与计数、
 * 队列写入、选择器与材料展示分别由工作区和面板持有。页面不访问 API、
 * Query、命令所有者或 localStorage。
 */

import { TrainingWorkspace } from '@/features/training'

export default function OperatorTraining() {
  return (
    <div className="app-page ios-workspace-page training-workspace" data-page="training">
      <TrainingWorkspace />
    </div>
  )
}
