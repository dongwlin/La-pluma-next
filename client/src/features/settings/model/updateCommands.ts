// core 更新、渠道切换、CLI 更新与资源热更新都是显式命令：四条共用一条在途槽位，并发
// 调用返回 ignored；命令提交为服务端 Run 后按 runId 观察终态，停止映射为目标 run 的停止
// 请求；成功后的跨域失效由 React 适配层发布，命令自己不清缓存；寿命不跟随页面，Activity
// 隐藏或重挂载不取消在途命令。

import {
  getErrorMessage,
  type ApiResponse,
} from '@/shared/api'
import {
  hotUpdateResources as defaultHotUpdateResources,
  updateMaaCli as defaultUpdateMaaCli,
  updateMaaCore as defaultUpdateMaaCore,
} from '../api'
import {
  failedExecution,
  initialUpdateState,
  resolveCoreChannelSwitch,
  shouldRetryUpdateResources,
  shouldRetryUpdateResourcesFromDetails,
  succeededExecution,
  terminalExecution,
  type SettingsUpdateState,
  type UpdateCommandOutcome,
  type UpdateExecution,
  type UpdateOperation,
} from './updateCommandPolicy'
import {
  createSettingsUpdateRunPort,
  type SettingsUpdateRunPort,
  type UpdateRunTerminal,
} from './updateRunPort'

export * from './updateCommandPolicy'

type UpdateRequest = (version?: string) => Promise<ApiResponse>
type CliUpdateRequest = (channel?: string) => Promise<ApiResponse>

export interface SettingsUpdateOwnerOptions {
  readonly updateCore?: UpdateRequest
  readonly updateCli?: CliUpdateRequest
  readonly updateResources?: () => Promise<ApiResponse>
  readonly runPort?: SettingsUpdateRunPort
}

export class SettingsUpdateOwner {
  private readonly updateCoreRequest: UpdateRequest
  private readonly updateCliRequest: NonNullable<SettingsUpdateOwnerOptions['updateCli']>
  private readonly updateResourcesRequest: NonNullable<SettingsUpdateOwnerOptions['updateResources']>
  private readonly runPort: SettingsUpdateRunPort

  private state: SettingsUpdateState = initialUpdateState()
  private readonly listeners = new Set<() => void>()
  private activeRunId: string | null = null

  constructor(options: SettingsUpdateOwnerOptions = {}) {
    this.updateCoreRequest = options.updateCore ?? (version => defaultUpdateMaaCore(version))
    this.updateCliRequest = options.updateCli ?? (() => defaultUpdateMaaCli())
    this.updateResourcesRequest = options.updateResources ?? (() => defaultHotUpdateResources())
    this.runPort = options.runPort ?? createSettingsUpdateRunPort()
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
    this.activeRunId = null
    this.state = initialUpdateState()
    this.notify()
  }

  /** 普通 core 更新：不传版本，服务端使用 `maa update` 并同步资源。 */
  async updateCore(): Promise<UpdateCommandOutcome> {
    return this.run('core', async () => {
      const { response, terminal } = await this.submitAndWait(
        'update_core',
        () => this.updateCoreRequest(),
      )
      if (!response.success) {
        return failedExecution(getErrorMessage(response), shouldRetryUpdateResources(response))
      }
      if (terminal) {
        const outcome = terminalExecution(terminal, {
          resourceRetry: shouldRetryUpdateResourcesFromDetails,
          showFeedback: true,
        })
        if (outcome) return outcome
      }
      const message = terminal
        ? 'MaaCore 和资源已更新'
        : (response.message || 'MaaCore 和资源已更新')
      return succeededExecution(message, true, true)
    })
  }

  /** 切换 core 渠道；服务端以 install --force 安装并同步资源。 */
  async switchCoreChannel(
    currentCore: string | null | undefined,
  ): Promise<UpdateCommandOutcome> {
    const target = resolveCoreChannelSwitch(currentCore)
    return this.run('core-channel', async () => {
      const { response, terminal } = await this.submitAndWait(
        'update_core',
        () => this.updateCoreRequest(target.version),
      )
      if (!response.success) {
        return failedExecution(getErrorMessage(response), shouldRetryUpdateResources(response))
      }
      const message = `已切换到 ${target.label} 渠道并同步最新资源`
      if (terminal) {
        const outcome = terminalExecution(terminal, {
          resourceRetry: shouldRetryUpdateResourcesFromDetails,
          showFeedback: true,
        })
        if (outcome) return outcome
      }
      return succeededExecution(message, true, true)
    })
  }

  /** CLI 更新只改变版本，不影响游戏资源；channel 缺省时服务端使用持久化渠道。 */
  async updateCli(channel?: string): Promise<UpdateCommandOutcome> {
    return this.run('cli', async () => {
      const { response, terminal } = await this.submitAndWait(
        'update_cli',
        () => this.updateCliRequest(channel),
      )
      if (!response.success) {
        return failedExecution(
          `更新失败: ${getErrorMessage(response)}`,
          false,
          false,
        )
      }
      if (terminal) {
        const outcome = terminalExecution(terminal, {
          resourceRetry: () => false,
          showFeedback: false,
        })
        if (outcome) return outcome
      }
      return succeededExecution('MAA CLI 更新成功', false, true)
    })
  }

  /** 仅同步游戏资源；任何失败都可以直接重试资源同步。 */
  async updateResources(): Promise<UpdateCommandOutcome> {
    return this.run('resources', async () => {
      const { response, terminal } = await this.submitAndWait(
        'update_resources',
        () => this.updateResourcesRequest(),
      )
      if (!response.success) {
        return failedExecution(getErrorMessage(response), true)
      }
      if (terminal) {
        const outcome = terminalExecution(terminal, {
          resourceRetry: () => true,
          showFeedback: true,
        })
        if (outcome) return outcome
      }
      const message = terminal ? '资源文件更新成功' : (response.message || '资源文件更新成功')
      return succeededExecution(message, true, true)
    })
  }

  /**
   * 停止在途更新：只作用于本次命令提交的 run。成功只代表停止意图已记录，
   * 命令仍要等到 run 终态才结束；失败时恢复可重试状态。
   */
  async cancel(): Promise<{ ok: boolean; message: string | null }> {
    if (this.state.running === null) return { ok: false, message: null }
    const runId = this.activeRunId
    if (!runId) {
      return { ok: false, message: '更新尚未获得执行身份，暂时无法停止' }
    }

    this.state = { ...this.state, canceling: true }
    this.notify()
    try {
      const result = await this.runPort.cancel(runId)
      if (result && !result.success) {
        this.state = { ...this.state, canceling: false }
        this.notify()
        return { ok: false, message: getErrorMessage(result) || '停止更新失败' }
      }
      return { ok: true, message: null }
    } catch (error) {
      this.state = { ...this.state, canceling: false }
      this.notify()
      return {
        ok: false,
        message: error instanceof Error ? error.message : '停止更新失败',
      }
    }
  }

  /** 提交更新并等待终态；没有 runId 的旧同步响应直接作为最终结果。 */
  private async submitAndWait(
    operationId: string,
    request: () => Promise<ApiResponse>,
  ): Promise<{ response: ApiResponse; terminal: UpdateRunTerminal | null }> {
    const response = await request()
    if (!response.success) return { response, terminal: null }

    const runId = this.runPort.adopt(response, operationId)
    if (!runId) return { response, terminal: null }

    this.activeRunId = runId
    try {
      return { response, terminal: await this.runPort.wait(runId) }
    } finally {
      this.activeRunId = null
      this.runPort.release(runId)
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
      canceling: false,
    }
    this.notify()

    let execution: UpdateExecution
    try {
      execution = await execute()
    } catch (error) {
      const message = `网络错误: ${(error as Error).message}`
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
    this.state = { running: null, feedback, canceling: false }
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
