/**
 * 用户配置持久化协调器
 *
 * 按配置 key 串行提交，状态与队列的寿命不跟随页面挂载：协调器实例由应用持有，
 * 页面卸载或 Activity 隐藏都不会让已排队的提交消失，重挂载也不会重建队列。
 *
 * 协调器不理解字段语义，也不把 `saveUserConfig` 成功直接当成完整持久化成功：
 * 一次提交要写入哪些端点、什么条件下才算完成，由域适配器的 `commit` 定义
 * （例如 automation 还必须完成 setup/stop schedule）。协调器只负责：
 *
 * - revision/token：旧提交的成功/失败都不能确认或覆盖更新的草稿；
 * - pending 标记：本地未确认草稿跨挂载优先于服务端副本；
 * - 提交次序：同一 key 的提交按入队顺序串行，可用去抖合并连续编辑；
 * - 迟到响应：加载与提交返回时都重新校验身份，过期结果不写状态。
 */

/** 协调器使用的键值存储；生产为 localStorage，测试注入内存实现。 */
export interface ConfigKeyStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * 一次完整提交的结果。`ok: false` 表示尚未完整持久化——协调器必须保留 pending
 * 草稿与重试入口，不能因为其中一部分请求成功就确认草稿。
 */
export type ConfigCommitResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

/** 一次服务端读取的结果；载荷是否可用由适配器的 `decodeDraft` 判定。 */
export type ConfigLoadResult =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly message: string }

/**
 * 配置 key 的持久化适配器。
 *
 * 适配器是域内唯一的配置所有者：本地草稿布局、服务端 wire 格式、旧格式迁移、
 * 提交时机和完整提交条件都在这里定义。协调器按 `key` 注册实现，因此同一 key
 * 的适配器必须同构（同一 pending 键、同一 wire 语义、同一完整提交条件）；
 * 页面重挂载可以用新实例替换实现，但队列与状态不会因此重置。
 */
export interface ConfigPersistenceAdapter<TDraft, TWire = unknown> {
  /** 服务端配置 key（如 `combat-tasks`），同时是协调器中的唯一身份。 */
  readonly key: string
  /** 本设备 pending 标记的存储键（如 `combatConfigSyncPending`）。 */
  readonly pendingKey: string
  /**
   * 编辑到提交的延迟。`0` 表示每次编辑立即入队（automation 的事件触发策略）；
   * 大于 0 表示去抖，只提交最后一次编辑（combat/roguelike 的 300ms 策略）。
   * 无论哪种策略，提交都在同一队列中串行。
   */
  readonly commitDelayMs?: number
  /** 挂载时发现本设备未同步草稿的提示；默认「上次更改已保存在此设备，但尚未同步到服务器。」 */
  readonly restoredMessage?: string
  /** 提交失败文案；默认「配置已保存在此设备，但尚未同步到服务器：<原因>」。 */
  readonly formatFailure?: (message: string) => string

  /** draft → 服务端 wire 载荷。不得包含只属于界面的字段。 */
  encodeDraft(draft: TDraft): TWire
  /**
   * 服务端载荷 → draft；同时承担旧格式迁移与形状校验。
   * 返回 null 表示该载荷不可用，协调器随后回退到本地草稿。
   */
  decodeDraft(payload: unknown): TDraft | null
  /**
   * 读取本设备草稿。缺失、单个损坏键清理后都应返回 null，而不是抛出；
   * 返回 null 且存在 pending 标记时，协调器会把标记视为无草稿可恢复。
   */
  readLocalDraft(): TDraft | null
  /** 写入本设备草稿，必须与 `readLocalDraft` 对称。 */
  writeLocalDraft(draft: TDraft): void
  /** 完整提交；只有整份配置（含域内附带的写入，如 schedule）全部成功才返回 ok。 */
  commit(wire: TWire): Promise<ConfigCommitResult>
  /** 读取服务端配置；应在 signal 中止时停止继续处理响应。 */
  fetch(options: { signal: AbortSignal }): Promise<ConfigLoadResult>
  /** 草稿等价判断（默认对 wire 做 JSON 序列化），用于跳过重复提交。 */
  fingerprint?(draft: TDraft): string
}

/**
 * 同步状态：`queued` 表示草稿已接受、等待去抖或队列；`saving` 表示当前草稿
 * 正在提交；`failed` 表示当前草稿未能完整持久化（含挂载时恢复的旧草稿）。
 */
export type ConfigSyncState = 'idle' | 'queued' | 'saving' | 'failed'

export interface ConfigCoordinatorState<TDraft> {
  /** 最近一次接受或加载的草稿；首次加载完成前为 null。 */
  readonly draft: TDraft | null
  /** 是否已有可用草稿（服务端、本地回退或恢复的未同步草稿）。读取失败仍为 false。 */
  readonly hydrated: boolean
  /** 本设备存在尚未被完整提交确认的草稿。 */
  readonly pending: boolean
  readonly syncState: ConfigSyncState
  /** 最近一次同步失败的可展示原因；完整提交成功后清空。 */
  readonly error: string | null
  /** 每次接受新草稿递增；用于页面判断编辑与提交的对应关系。 */
  readonly revision: number
  /** 最近一次完整提交成功的时间戳。 */
  readonly lastSavedAt: number | null
}

export type ConfigReloadReason =
  /** 服务端或本地草稿已应用。 */
  | 'loaded'
  /** 未确认的本地草稿优先，未读取服务端。 */
  | 'local-draft'
  /** 已加载过且未强制刷新。 */
  | 'skipped'
  /** 加载期间出现新草稿或新加载，本次结果被丢弃。 */
  | 'stale'
  /** 服务端读取失败且没有可回退的草稿；下次 hydrate 会重试。 */
  | 'failed'

export interface ConfigReloadOutcome {
  readonly reason: ConfigReloadReason
}

/**
 * 单个配置 key 的协调通道。同一协调器对同一 key 始终返回同一通道，
 * 因此状态、队列和定时器跨页面挂载复用。
 */
export interface ConfigChannel<TDraft> {
  readonly key: string
  readonly getState: () => ConfigCoordinatorState<TDraft>
  readonly subscribe: (listener: () => void) => () => void
  /** 首次加载；已加载时返回 `skipped`。 */
  readonly hydrate: () => Promise<ConfigReloadOutcome>
  /** 重新读取；`force` 绕过已加载守卫，但不覆盖未确认的本地草稿。 */
  readonly reload: (options?: { force?: boolean }) => Promise<ConfigReloadOutcome>
  /** 接受一份新草稿：写本地、生成新 revision/token，并按适配器策略安排提交。 */
  readonly setDraft: (draft: TDraft) => void
  /** 立即提交当前草稿并等待结果；返回当前 revision 是否已被确认。 */
  readonly commitNow: () => Promise<boolean>
  /** 立即触发待提交的草稿并等待队列空闲。 */
  readonly flush: () => Promise<void>
  /** 停止定时器与在途加载，不清除草稿或 pending 标记。 */
  readonly dispose: () => void
}

export const DEFAULT_RESTORED_MESSAGE = '上次更改已保存在此设备，但尚未同步到服务器。'
const DEFAULT_FAILURE_PREFIX = '配置已保存在此设备，但尚未同步到服务器'

interface CommitSnapshot<TDraft> {
  readonly revision: number
  readonly draft: TDraft
  readonly token: string
}

interface ConfigKeyStateOptions<TDraft, TWire> {
  adapter: ConfigPersistenceAdapter<TDraft, TWire>
  storage: ConfigKeyStorage
  clock: () => number
  nextToken: () => string
}

function createNoopStorage(): ConfigKeyStorage {
  return {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  }
}

/**
 * 包装任意键值存储：隐私模式、配额或存储被禁用时，编辑仍应保留在内存中并允许重试。
 */
function toSafeStorage(target: ConfigKeyStorage | null): ConfigKeyStorage {
  if (!target) return createNoopStorage()
  return {
    getItem(key) {
      try {
        return target.getItem(key)
      } catch {
        return null
      }
    },
    setItem(key, value) {
      try {
        target.setItem(key, value)
      } catch {
        // pending 标记写不进去时，本次会话仍按内存状态提交。
      }
    },
    removeItem(key) {
      try {
        target.removeItem(key)
      } catch {
        // 忽略存储失败；内存状态已经先被清除。
      }
    },
  }
}

/** 默认键值存储：浏览器 localStorage；没有 localStorage 的环境退化为 no-op。 */
export function createConfigKeyStorage(storage?: Storage | null): ConfigKeyStorage {
  const target = storage === undefined
    ? (typeof localStorage === 'undefined' ? null : localStorage)
    : storage
  return toSafeStorage(target)
}

class ConfigKeyState<TDraft, TWire> implements ConfigChannel<TDraft> {
  readonly key: string

  private adapter: ConfigPersistenceAdapter<TDraft, TWire>
  private readonly storage: ConfigKeyStorage
  private readonly clock: () => number
  private readonly nextToken: () => string
  private readonly listeners = new Set<() => void>()

  private state: ConfigCoordinatorState<TDraft> = Object.freeze({
    draft: null as TDraft | null,
    hydrated: false,
    pending: false,
    syncState: 'idle' as ConfigSyncState,
    error: null,
    revision: 0,
    lastSavedAt: null,
  })

  private draft: TDraft | null = null
  private hydrated = false
  private pending = false
  private syncState: ConfigSyncState = 'idle'
  private error: string | null = null
  private revision = 0
  private lastSavedAt: number | null = null

  private token: string | null = null
  private fingerprint: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private queueTail: Promise<void> = Promise.resolve()
  private loadSequence = 0
  private loadAbort: AbortController | null = null
  private inflightLoad: Promise<ConfigReloadOutcome> | null = null

  constructor(options: ConfigKeyStateOptions<TDraft, TWire>) {
    this.adapter = options.adapter
    this.key = options.adapter.key
    this.storage = options.storage
    this.clock = options.clock
    this.nextToken = options.nextToken
  }

  /**
   * 页面重挂载会带来新的适配器实例；只替换实现，不重置状态与队列。
   * pending 键不同意味着两份草稿协议无法共存，直接暴露契约错误。
   */
  updateAdapter(adapter: ConfigPersistenceAdapter<TDraft, TWire>): void {
    if (adapter.pendingKey !== this.adapter.pendingKey) {
      throw new Error(
        `配置协调器不接受同一 key 的异构适配器：${this.key} 的 pending 键为 `
        + `${this.adapter.pendingKey}，收到 ${adapter.pendingKey}`,
      )
    }
    this.adapter = adapter
  }

  readonly getState = (): ConfigCoordinatorState<TDraft> => this.state

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly hydrate = (): Promise<ConfigReloadOutcome> => this.reload()

  readonly reload = (options: { force?: boolean } = {}): Promise<ConfigReloadOutcome> => {
    const force = options.force === true
    if (this.hydrated && !force) return Promise.resolve({ reason: 'skipped' })
    if (this.inflightLoad && !force) return this.inflightLoad

    const run = this.loadDraft()
    this.inflightLoad = run
    const clear = () => {
      if (this.inflightLoad === run) this.inflightLoad = null
    }
    void run.then(clear, clear)
    return run
  }

  readonly setDraft = (draft: TDraft): void => {
    const fingerprint = this.fingerprintOf(draft)
    // 页面常从表单状态派生草稿；内容等价时不重复入队，也不刷新 pending 令牌。
    if (fingerprint !== null && this.fingerprint === fingerprint) return

    this.draft = draft
    this.fingerprint = fingerprint
    this.revision += 1
    this.token = this.nextToken()
    this.pending = true
    this.syncState = 'queued'

    this.writeLocalDraft(draft)
    this.storage.setItem(this.adapter.pendingKey, this.token)
    this.publish()
    this.scheduleCommit()
  }

  readonly commitNow = async (): Promise<boolean> => {
    if (this.draft === null) return false
    const revision = this.revision
    this.cancelScheduledCommit()
    // 只等待本次尝试：同一 key 后续 revision 的提交由它们自己排，不能阻塞重试结果。
    if (this.pending && this.token !== null) {
      await this.enqueueCommit()
    }
    return this.revision === revision && !this.pending
  }

  readonly flush = async (): Promise<void> => {
    if (this.timer !== null) {
      this.cancelScheduledCommit()
      void this.enqueueCommit()
    }
    await this.queueTail
  }

  readonly dispose = (): void => {
    this.cancelScheduledCommit()
    this.abortLoad()
  }

  private async loadDraft(): Promise<ConfigReloadOutcome> {
    const storedToken = this.readPendingToken()
    if (storedToken !== null) {
      let localDraft: TDraft | null
      try {
        localDraft = this.adapter.readLocalDraft()
      } catch {
        // 有标记但读不出草稿时不能换成服务端副本，否则会静默丢掉本设备编辑。
        return { reason: 'failed' }
      }

      if (localDraft !== null) {
        // 本设备未确认的草稿按定义比服务端副本新，不读取服务端。
        // 本会话已有未确认草稿时以内存为准；否则采用存储里的草稿（跨会话、其它写入者或残留标记）。
        if (!this.pending) {
          this.draft = localDraft
          this.fingerprint = this.fingerprintOf(localDraft)
          this.token = storedToken
          this.pending = true
          this.syncState = 'failed'
          this.error = this.adapter.restoredMessage ?? DEFAULT_RESTORED_MESSAGE
        }
        this.hydrated = true
        this.publish()
        return { reason: 'local-draft' }
      }

      // 标记指向的草稿已损坏：删标记后继续读服务端，与既有页面的回退一致。
      this.storage.removeItem(this.adapter.pendingKey)
    }

    this.abortLoad()
    const controller = new AbortController()
    this.loadAbort = controller
    const sequence = ++this.loadSequence
    const startingRevision = this.revision

    let decoded: TDraft | null = null
    try {
      const result = await this.adapter.fetch({ signal: controller.signal })
      if (result.ok) decoded = this.decodeDraft(result.payload)
    } catch {
      // 读取失败与载荷不可用同样回退本地草稿。
    } finally {
      if (this.loadAbort === controller) this.loadAbort = null
    }

    if (!this.isCurrentLoad(sequence, startingRevision, controller)) {
      // 编辑已经发生：保留编辑，别把迟到的服务端副本写回页面。
      if (this.draft !== null) {
        this.hydrated = true
        this.publish()
      }
      return { reason: 'stale' }
    }

    if (decoded !== null) {
      this.adopt(decoded)
      this.hydrated = true
      this.publish()
      return { reason: 'loaded' }
    }

    let localDraft: TDraft | null
    try {
      localDraft = this.adapter.readLocalDraft()
    } catch {
      return { reason: 'failed' }
    }
    if (localDraft !== null) {
      this.adopt(localDraft)
      this.hydrated = true
      this.publish()
      return { reason: 'loaded' }
    }

    // 没有可用草稿：不标记 hydrated，下次 hydrate（如 Activity 恢复）会重试。
    return { reason: 'failed' }
  }

  private adopt(draft: TDraft): void {
    this.draft = draft
    this.fingerprint = this.fingerprintOf(draft)
    this.token = null
    this.pending = false
    this.syncState = 'idle'
    this.error = null
    this.writeLocalDraft(draft)
  }

  private isCurrentLoad(
    sequence: number,
    startingRevision: number,
    controller: AbortController,
  ): boolean {
    return sequence === this.loadSequence
      && !controller.signal.aborted
      && this.revision === startingRevision
      && this.readPendingToken() === null
  }

  private scheduleCommit(): void {
    this.cancelScheduledCommit()
    const delay = this.adapter.commitDelayMs ?? 0
    if (delay <= 0) {
      void this.enqueueCommit()
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.enqueueCommit()
    }, delay)
  }

  private cancelScheduledCommit(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private enqueueCommit(): Promise<void> {
    const snapshot = this.captureCommit()
    if (!snapshot) return this.queueTail

    const run = () => this.performCommit(snapshot)
    const attempt = this.queueTail.then(run, run)
    this.queueTail = attempt.then(() => undefined, () => undefined)
    return attempt
  }

  private captureCommit(): CommitSnapshot<TDraft> | null {
    if (this.draft === null || !this.pending || this.token === null) return null
    return { revision: this.revision, draft: this.draft, token: this.token }
  }

  private async performCommit(snapshot: CommitSnapshot<TDraft>): Promise<void> {
    // 入队后草稿可能又变了：旧快照无需发起请求，提交由新 revision 自己排。
    if (!this.isCurrentCommit(snapshot)) return

    this.syncState = 'saving'
    this.publish()

    try {
      const wire = this.adapter.encodeDraft(snapshot.draft)
      const result = await this.adapter.commit(wire)
      if (!result.ok) throw new Error(result.message)

      // 旧提交即使成功也不能确认新草稿：保留新令牌与 pending 标记。
      if (!this.isCurrentCommit(snapshot)) return

      this.storage.removeItem(this.adapter.pendingKey)
      this.token = null
      this.pending = false
      this.syncState = 'idle'
      this.error = null
      this.lastSavedAt = this.clock()
      this.publish()
    } catch (error) {
      if (!this.isCurrentCommit(snapshot)) return
      this.syncState = 'failed'
      this.error = this.describeFailure(error)
      this.publish()
    }
  }

  private isCurrentCommit(snapshot: CommitSnapshot<TDraft>): boolean {
    return this.revision === snapshot.revision
      && this.token === snapshot.token
      && this.readPendingToken() === snapshot.token
  }

  private describeFailure(error: unknown): string {
    const detail = error instanceof Error && error.message
      ? error.message
      : '暂时无法连接服务器'
    return this.adapter.formatFailure
      ? this.adapter.formatFailure(detail)
      : `${DEFAULT_FAILURE_PREFIX}：${detail}`
  }

  private fingerprintOf(draft: TDraft): string | null {
    try {
      if (this.adapter.fingerprint) return this.adapter.fingerprint(draft)
      const wire = this.adapter.encodeDraft(draft)
      return wire === undefined ? null : JSON.stringify(wire)
    } catch {
      return null
    }
  }

  private decodeDraft(payload: unknown): TDraft | null {
    try {
      return this.adapter.decodeDraft(payload)
    } catch {
      return null
    }
  }

  private writeLocalDraft(draft: TDraft): void {
    try {
      this.adapter.writeLocalDraft(draft)
    } catch {
      // 本地回写失败不阻断内存状态与提交；下次挂载按 pending 标记处理。
    }
  }

  private readPendingToken(): string | null {
    return this.storage.getItem(this.adapter.pendingKey)
  }

  private abortLoad(): void {
    const controller = this.loadAbort
    if (!controller) return
    this.loadAbort = null
    controller.abort()
  }

  private publish(): void {
    this.state = Object.freeze({
      draft: this.draft,
      hydrated: this.hydrated,
      pending: this.pending,
      syncState: this.syncState,
      error: this.error,
      revision: this.revision,
      lastSavedAt: this.lastSavedAt,
    })
    for (const listener of this.listeners) listener()
  }
}

export interface UserConfigCoordinatorOptions {
  /** 键值存储；默认 localStorage。`null` 表示只保留内存状态（测试或存储不可用）。 */
  storage?: ConfigKeyStorage | null
  now?: () => number
}

/** 排空指定配置通道后的结果；`pendingKeys` 是仍未完整提交的配置 key。 */
export interface ConfigSettleResult {
  readonly pendingKeys: readonly string[]
}

/**
 * 应用级协调器。按 key 保存通道，因此提交队列、pending 标记与草稿状态
 * 都不依赖某一个页面实例的生命周期。
 */
export class UserConfigCoordinator {
  private readonly storage: ConfigKeyStorage
  private readonly clock: () => number
  private readonly channels = new Map<string, ConfigKeyState<any, any>>()
  private tokenSequence = 0

  constructor(options: UserConfigCoordinatorOptions = {}) {
    this.storage = options.storage === undefined
      ? createConfigKeyStorage()
      : toSafeStorage(options.storage)
    this.clock = options.now ?? Date.now
  }

  channel<TDraft, TWire>(adapter: ConfigPersistenceAdapter<TDraft, TWire>): ConfigChannel<TDraft> {
    const existing = this.channels.get(adapter.key)
    if (existing) {
      existing.updateAdapter(adapter)
      return existing
    }
    const created = new ConfigKeyState<TDraft, TWire>({
      adapter,
      storage: this.storage,
      clock: this.clock,
      nextToken: () => this.nextToken(),
    })
    this.channels.set(adapter.key, created)
    return created
  }

  /** 停止全部通道的定时器与在途加载；用于测试隔离或应用级销毁。 */
  dispose(): void {
    for (const channel of this.channels.values()) channel.dispose()
    this.channels.clear()
  }

  /**
   * 等待指定 key 当前已入队的提交全部结束。
   *
   * 用于“另一个域即将写入同一服务端文件”前的写入屏障：调用方先让本域的
   * 在途保存落盘，再发出会改写该文件的请求，避免旧保存后到覆盖新内容。
   * 不触发已失败草稿的自动重试，也不创建尚未挂载的通道；`pendingKeys`
   * 返回仍未完整提交的 key，调用方据此拒绝继续。
   */
  async settle(keys: readonly string[]): Promise<ConfigSettleResult> {
    const channels = keys
      .map(key => this.channels.get(key))
      .filter((channel): channel is ConfigKeyState<any, any> => Boolean(channel))
    await Promise.all(channels.map(channel => channel.flush()))
    return {
      pendingKeys: channels
        .filter(channel => channel.getState().pending)
        .map(channel => channel.key),
    }
  }

  private nextToken(): string {
    this.tokenSequence += 1
    return `${this.clock()}-${this.tokenSequence}`
  }
}

export const userConfigCoordinator = new UserConfigCoordinator()
