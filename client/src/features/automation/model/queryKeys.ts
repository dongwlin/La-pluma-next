/**
 * 自动任务域 Query key
 *
 * 域标识 `automation` 与 feature 目录一致。总览完整快照通过 `activity` 与
 * `schedule-execution` 读取当前活动与定时执行状态；活动接口的客户端类型
 * 影响响应内容，因此进入 key。页面上的任务流程/定时配置不是普通资源，
 * 仍由配置协调器与定时写入命令持有。
 */

import { defineQueryKeys } from '@/shared/query'

export const AUTOMATION_DOMAIN = 'automation' as const

export const automationKeys = defineQueryKeys(AUTOMATION_DOMAIN)

export type AutomationResource = 'activity' | 'schedule-execution'
