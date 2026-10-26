/**
 * 作业页的任务目录与模式展示项
 *
 * 命令名、名称、占位与描述只服务本域页面；执行参数拼接仍在
 * `model/combatCommands.ts`。目录不读取配置、Query 或执行状态。
 */

import type { ReactNode } from 'react'
import Icons from '@/shared/ui/Icons'
import type { CombatMode, CombatTask } from '../types'

export const COMBAT_TASKS: Record<CombatMode, CombatTask> = {
  copilot: {
    id: 'copilot',
    name: '自动战斗作业',
    command: 'copilot',
    placeholder: 'prts://1234、作业站链接或本地文件路径',
    icon: <Icons.Document />,
    hasAdvanced: true,
    description: '支持单作业、作业集、作业站链接、循环次数与失败处理策略',
  },
  ssscopilot: {
    id: 'ssscopilot',
    name: '保全派驻',
    command: 'ssscopilot',
    placeholder: 'prts://1234 或本地文件路径',
    icon: <Icons.Shield />,
    hasAdvanced: true,
    description: '保全派驻作业入口，一次只能执行一份作业',
  },
  paradoxcopilot: {
    id: 'paradoxcopilot',
    name: '悖论模拟',
    command: 'paradoxcopilot',
    placeholder: 'prts://1234 或本地文件路径',
    icon: <Icons.Puzzle />,
    hasAdvanced: true,
    description: '悖论模拟独立作业入口，可按干员搜索推荐作业并单独诊断',
  },
}

export const COMBAT_MODE_OPTIONS: ReadonlyArray<{
  id: CombatMode
  title: string
  desc: string
  icon: ReactNode
}> = [
  {
    id: 'copilot',
    title: '普通作业',
    desc: '单作业 / 作业集 / 链接识别',
    icon: <Icons.Document />,
  },
  {
    id: 'ssscopilot',
    title: '保全派驻',
    desc: '保全派驻自动执行',
    icon: <Icons.Shield />,
  },
  {
    id: 'paradoxcopilot',
    title: '悖论模拟',
    desc: '按干员搜索作业',
    icon: <Icons.Puzzle />,
  },
]

export function getCombatTask(mode: CombatMode): CombatTask {
  return COMBAT_TASKS[mode]
}
