/**
 * 任务执行微域公开面
 * 跨域共用的命令执行与任务状态控制端点。
 */

export {
  executeCommand,
  executePredefinedTask,
  executePredefinedTaskArgs,
  getTaskStatus,
  stopTask,
} from './api'
export type { TaskConfig } from './api'
