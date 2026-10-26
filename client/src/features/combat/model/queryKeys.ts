/**
 * 自动战斗域 Query key
 *
 * 域标识 `combat` 与 feature 目录一致。搜索、单作业与作业集详情各有一个稳定
 * 资源名，参数只放影响响应的输入：
 *
 * | 资源 | 参数 | 缓存身份 |
 * | --- | --- | --- |
 * | `copilot-search` | 关卡搜索词 | `['combat','copilot-search',stage]` |
 * | `paradox-search` | 干员搜索词 | `['combat','paradox-search',name]` |
 * | `copilot` | 作业 id | `['combat','copilot',id]` |
 * | `copilot-set` | 作业集 id | `['combat','copilot-set',id]` |
 * | `copilot-set-plan` | 作业集 id、模式 | `['combat','copilot-set-plan',id,raid]` |
 *
 * 预览按钮、识别方式（自动/单个/作业集）和选中索引是客户端选择，不进入 key。
 */

import { defineQueryKeys } from '@/shared/query'

export const COMBAT_DOMAIN = 'combat' as const

export const combatKeys = defineQueryKeys(COMBAT_DOMAIN)

export type CombatResource =
  | 'copilot-search'
  | 'paradox-search'
  | 'copilot'
  | 'copilot-set'
  | 'copilot-set-plan'
