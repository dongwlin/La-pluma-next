/**
 * 设置页组件更新命令所有者
 *
 * core 更新、core 渠道切换、CLI 更新与资源热更新都是带副作用的显式命令，
 * 不是可自动重取的只读资源：不进入 Query，失败也不自动重试。
 *
 * - 四条命令共用一条在途槽位：任意一条运行期间再次发起（包括同一命令）返回
 *   `ignored`，不会发出第二个请求；页面据此禁用全部更新按钮并只让实际运行的
 *   按钮显示 loading。
 * - core 更新与渠道切换在服务端会同时安装组件并同步资源；成功后报告
 *   `resourcesChanged`，由 React 适配层发布跨域失效，而不是由命令自己清空缓存。
 * - core/热更新的失败可标记 `resourceRetry`（资源步骤失败或 core 已更新），
 *   页面提供显式“重试资源同步”入口；该入口仍是用户动作，不是自动重试。
 * - CLI 更新沿用迁移前只有全局提示、没有页内反馈的行为。
 * - 寿命不跟随页面：Activity 隐藏或页面重挂载不取消在途命令，完成后仍写状态。
 */

import {
  getErrorMessage,
  isRecord,
  type ApiResponse,
} from '@/shared/api'
import type { ResourceScope } from '@/features/resource-invalidation'
import {
  hotUpdateResources as defaultHotUpdateResources,
  updateMaaCli as defaultUpdateMaaCli,
  updateMaaCore as defaultUpdateMaaCore,
} from '../api'

export type UpdateOperation = 'core' | 'core-channel' | 'cli' | 'resources'

/**
 * 组件/资源更新成功后受影响的作用域。
 *
 * core 更新与渠道切换在服务端同时同步资源，因此与“仅同步游戏资源”一样发布
 * 目录、材料、计划前提与总览；CLI 更新只改变版本，不发布任何资源失效。
 * 不在这里清空缓存，也不发布未受影响的 `depot`/`operbox` 等识别快照。
 */
export const SETTINGS_UPDATE_RESOURCE_SCOPES = [
  'catalog',
  'materials',
  'training-plan',
  'dashboard-snapshot',
] as const satisfies readonly ResourceScope[]

export interface UpdateFeedback {
  readonly type: 'success' | 'error'
  readonly message: string
  /** core/热更新部分失败后，页面显示“重试资源同步”入口。 */
  readonly resourceRetry: boolean
}

export interface SettingsUpdateState {
  readonly running: UpdateOperation | null
  readonly feedback: UpdateFeedback | null
}

export type UpdateCommandStatus = 'succeeded' | 'failed' | 'ignored'

export interface UpdateCommandOutcome {
  readonly status: UpdateCommandStatus
  readonly operation: UpdateOperation
  /** 页内反馈；CLI 更新为 null（迁移前没有页内反馈）。 */
  readonly feedback: UpdateFeedback | null
  /** 完成后的全局状态提示；`ignored` 为 null。 */
  readonly message: string | null
  /** 只有失败显式指定 error，其余沿用全局状态的消息类型推断。 */
  readonly messageType: 'error' | null
  /** 成功更新了游戏资源，适配层需要发布 `catalog`/`materials` 等失效。 */
  readonly resourcesChanged: boolean
  /** 组件或资源版本可能变化，适配层需要重取 `settings/version`。 */
  readonly versionChanged: boolean
}

export type CoreUpdateVersion = 'beta' | 'stable'

export interface CoreChannelSwitch {
  readonly version: CoreUpdateVersion
  readonly label: 'Beta' | '正式版'
}

export const coreChannelLabel = (version: CoreUpdateVersion): CoreChannelSwitch['label'] => (
  version === 'beta' ? 'Beta' : '正式版'
)

/**
 * 根据当前 core 版本决定切换目标：beta/alpha 切回正式版，其余切到 Beta。
 * 版本读取失败（`null`）时沿用迁移前的默认目标 Beta。
 */
export const resolveCoreChannelSwitch = (
  currentCore: string | null | undefined,
): CoreChannelSwitch => {
  const isBeta = typeof currentCore === 'string'
    && (currentCore.includes('beta') || currentCore.includes('alpha'))
  const version: CoreUpdateVersion = isBeta ? 'stable' : 'beta'
  return { version, label: coreChannelLabel(version) }
}

type UpdateRequest = (version?: string) => Promise<ApiResponse>

export interface SettingsUpdateOwnerOptions {
  readonly updateCore?: UpdateRequest
  readonly updateCli?: () => Promise<ApiResponse>
  readonly updateResources?: () => Promise<ApiResponse>
}

interface UpdateExecution {
  readonly status: 'succeeded' | 'failed'
  readonly feedback: UpdateFeedback | null
  readonly message: string
  readonly messageType: 'error' | null
  readonly resourcesChanged: boolean
  readonly versionChanged: boolean
}

const initialState = (): SettingsUpdateState => ({
  running: null,
  feedback: null,
})

const describeRequestError = (error: unknown): string => (
  `${(error as Error).message}`
)

/**
 * core 更新的失败详情可能来自当前信封的 `errorInfo.details`，也可能来自旧
 * 服务端/旧调用的 `error.details`；两种形状都读取，其余忽略。
 */
export const readUpdateFailureDetails = (
  result: ApiResponse,
): Record<string, unknown> => {
  const infoDetails = result.errorInfo?.details
  if (isRecord(infoDetails)) return infoDetails

  const legacyError = (result as { error?: unknown }).error
  if (isRecord(legacyError) && isRecord(legacyError.details)) {
    return legacyError.details
  }
  return {}
}

/** 资源步骤失败或 core 已更新时，页面提供显式资源重试入口。 */
export const shouldRetryUpdateResources = (result: ApiResponse): boolean => {
  const details = readUpdateFailureDetails(result)
  return details.failedStep === 'resources' || details.coreUpdated === true
}

export class SettingsUpdateOwner {
  private readonly updateCoreRequest: UpdateRequest
  private readonly updateCliRequest: NonNullable<SettingsUpdateOwnerOptions['updateCli']>
  private readonly updateResourcesRequest: NonNullable<SettingsUpdateOwnerOptions['updateResources']>

  private state: SettingsUpdateState = initialState()
  private readonly listeners = new Set<() => void>()

  constructor(options: SettingsUpdateOwnerOptions = {}) {
    this.updateCoreRequest = options.updateCore ?? (version => defaultUpdateMaaCore(version))
    this.updateCliRequest = options.updateCli ?? (() => defaultUpdateMaaCli())
    this.updateResourcesRequest = options.updateResources ?? (() => defaultHotUpdateResources())
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getState = (): SettingsUpdateState => this.state

  /** 仅用于测试与明确的全局重置；正常页面生命周期不调用。 */
  reset(): void {
    this.state = initialState()
    this.notify()
  }

  /** 普通 core 更新：不传版本，服务端使用 `maa update` 并同步资源。 */
  async updateCore(): Promise<UpdateCommandOutcome> {
    return this.run('core', async () => {
      const result = await this.updateCoreRequest()
      if (!result.success) {
        const message = getErrorMessage(result)
        return this.failed(message, shouldRetryUpdateResources(result))
      }

      const message = result.message || 'MaaCore 和资源已更新'
      return {
        status: 'succeeded',
        feedback: { type: 'success', message, resourceRetry: false },
        message,
        messageType: null,
        resourcesChanged: true,
        versionChanged: true,
      }
    })
  }

  /** 切换 core 渠道；服务端以 install --force 安装并同步资源。 */
  async switchCoreChannel(
    currentCore: string | null | undefined,
  ): Promise<UpdateCommandOutcome> {
    const target = resolveCoreChannelSwitch(currentCore)
    return this.run('core-channel', async () => {
      const result = await this.updateCoreRequest(target.version)
      if (!result.success) {
        const message = getErrorMessage(result)
        return this.failed(message, shouldRetryUpdateResources(result))
      }

      const message = `已切换到 ${target.label} 渠道并同步最新资源`
      return {
        status: 'succeeded',
        feedback: { type: 'success', message, resourceRetry: false },
        message,
        messageType: null,
        resourcesChanged: true,
        versionChanged: true,
      }
    })
  }

  /** CLI 更新只改变版本，不影响游戏资源。 */
  async updateCli(): Promise<UpdateCommandOutcome> {
    return this.run('cli', async () => {
      const result = await this.updateCliRequest()
      if (!result.success) {
        return {
          status: 'failed',
          feedback: null,
          message: `更新失败: ${getErrorMessage(result)}`,
          messageType: 'error',
          resourcesChanged: false,
          versionChanged: false,
        }
      }

      return {
        status: 'succeeded',
        feedback: null,
        message: 'MAA CLI 更新成功',
        messageType: null,
        resourcesChanged: false,
        versionChanged: true,
      }
    })
  }

  /** 仅同步游戏资源；任何失败都可以直接重试资源同步。 */
  async updateResources(): Promise<UpdateCommandOutcome> {
    return this.run('resources', async () => {
      const result = await this.updateResourcesRequest()
      if (!result.success) {
        return this.failed(getErrorMessage(result), true)
      }

      const message = result.message || '资源文件更新成功'
      return {
        status: 'succeeded',
        feedback: { type: 'success', message, resourceRetry: false },
        message,
        messageType: null,
        resourcesChanged: true,
        versionChanged: true,
      }
    })
  }

  private failed(message: string, resourceRetry: boolean): UpdateExecution {
    return {
      status: 'failed',
      feedback: { type: 'error', message, resourceRetry },
      message,
      messageType: 'error',
      resourcesChanged: false,
      versionChanged: false,
    }
  }

  private async run(
    operation: UpdateOperation,
    execute: () => Promise<UpdateExecution>,
  ): Promise<UpdateCommandOutcome> {
    if (this.state.running !== null) {
      return {
        status: 'ignored',
        operation,
        feedback: null,
        message: null,
        messageType: null,
        resourcesChanged: false,
        versionChanged: false,
      }
    }

    // CLI 更新沿用迁移前行为：开始与结束都不清空 core/资源更新的页内反馈。
    this.state = {
      running: operation,
      feedback: operation === 'cli' ? this.state.feedback : null,
    }
    this.notify()

    let execution: UpdateExecution
    try {
      execution = await execute()
    } catch (error) {
      const message = `网络错误: ${describeRequestError(error)}`
      execution = {
        status: 'failed',
        feedback: operation === 'cli'
          ? null
          : { type: 'error', message, resourceRetry: operation === 'resources' },
        message,
        messageType: 'error',
        resourcesChanged: false,
        versionChanged: false,
      }
    }

    const feedback = operation === 'cli' ? this.state.feedback : execution.feedback
    this.state = { running: null, feedback }
    this.notify()

    return {
      status: execution.status,
      operation,
      // CLI 不产生页内反馈；state 中保留的是此前 core/资源更新的反馈。
      feedback: execution.feedback,
      message: execution.message,
      messageType: execution.messageType,
      resourcesChanged: execution.resourcesChanged,
      versionChanged: execution.versionChanged,
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

export const settingsUpdateOwner = new SettingsUpdateOwner()
