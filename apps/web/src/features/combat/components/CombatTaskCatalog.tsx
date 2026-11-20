import type { ReactNode } from 'react'
import Icons from '@/shared/components/Icons'
import type { CombatMode, CombatTask } from '../types'

export const COMBAT_TASKS: Record<CombatMode, CombatTask> = {
  copilot: {
    id: 'copilot',
    name: '自动战斗作业',
    command: 'copilot',
    placeholder: 'prts://1234、作业站链接或本地文件路径',
    hasAdvanced: true,
  },
  ssscopilot: {
    id: 'ssscopilot',
    name: '保全派驻',
    command: 'ssscopilot',
    placeholder: 'prts://1234 或本地文件路径',
    hasAdvanced: true,
  },
  paradoxcopilot: {
    id: 'paradoxcopilot',
    name: '悖论模拟',
    command: 'paradoxcopilot',
    placeholder: 'prts://1234 或本地文件路径',
    hasAdvanced: true,
  },
}

export const COMBAT_MODE_OPTIONS: ReadonlyArray<{
  id: CombatMode
  title: string
  icon: ReactNode
}> = [
  {
    id: 'copilot',
    title: '普通作业',
    icon: <Icons.Document />,
  },
  {
    id: 'ssscopilot',
    title: '保全派驻',
    icon: <Icons.Shield />,
  },
  {
    id: 'paradoxcopilot',
    title: '悖论模拟',
    icon: <Icons.Puzzle />,
  },
]

export function getCombatTask(mode: CombatMode): CombatTask {
  return COMBAT_TASKS[mode]
}
