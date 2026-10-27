# 设置

> [← 返回前端架构](../README.md) · [文档索引](../../README.md)

本文集中维护本领域的面板、模型与命令约定；通用契约通过链接引用。

- [页面与面板](#页面与面板)
- [配置编辑与保存](#配置编辑与保存)
- [设备连接与系统资源](#设备连接与系统资源)
- [组件更新与自动更新](#组件更新与自动更新)
- [回归与关联](#回归与关联)

## 页面与面板

连接草稿、设备命令、版本/目录读取、组件更新与自动更新的所有者、Query key、wire 与失效语义均未改变；页面/面板分别承担组合与订阅职责，不新增缓存、命令状态或存储。

### 1. 定位与边界

| 内容 | 唯一归属 | 说明 |
| --- | --- | --- |
| 页面壳 | `pages/settings/ConfigManager.tsx` | 只渲染 `app-page`/`data-page` 并组合工作区 |
| 页头、section 导航与布局 | `features/settings/components/SettingsWorkspace.tsx` | section 订阅、页头、工作区网格与面板组合 |
| 配置 section 分段 | `features/settings/components/ConfigSectionNav.tsx` | `role="toolbar"`、`aria-pressed`、方向键导航与流体高亮 |
| section 展示文案 | `features/settings/components/configSectionViews.tsx` | 名称、说明与图标；不持有存储或事件 |
| connection 表单、保存与读取反馈 | `features/settings/components/ConnectionConfigPanel.tsx` | Query/草稿适配、保存/重置、迟到读取提示；非 connection section 返回 null |
| 模拟器查找与连接测试 | `features/settings/components/DeviceConnectionPanel.tsx` | 命令 owner 订阅、设备列表、独立 loading/反馈 |
| resource/instance 只读说明与目录入口 | `features/settings/components/ReadOnlyConfigPanel.tsx` | 不渲染保存/重置；头部“打开目录” |
| 配置目录 | `features/settings/components/ConfigDirectoryPanel.tsx` | 路径三态、重试与“打开目录” |
| 组件更新卡片容器 | `features/settings/components/SettingsUpdatesPanel.tsx` | 共享标题与 0 间距内容布局 |
| 自动更新策略 | `features/settings/components/AutoUpdateConfigPanel.tsx` | 自动更新草稿、本地回退、完整提交与反馈 |
| 版本与组件更新 | `features/settings/components/ComponentUpdatePanel.tsx` | 版本 Query、core/渠道/CLI/资源命令与反馈 |

维护约束：

- 不改变 connection 字段、wire 与保存时机；自动更新仍先写 user config 再应用调度。
- 不改变 Query key、读取时机、失败/重试、失效作用域与展示文案。
- 不改变设备发现/连接测试的取消、迟到响应与草稿回填语义；取消仍跟随页面/Activity，而不是 section。
- 不改变渲染结构、DOM 类名、CSS 或默认态视觉；不更新视觉基线。

### 2. 组合与订阅边界

```
ConfigManager（页面壳）
└─ SettingsWorkspace（section 订阅、页头、布局、设备命令的 Activity 清理）
   ├─ ConfigSectionNav（分段 + 流体高亮）
   ├─ ConnectionConfigPanel（connection Query/草稿/保存反馈，非当前 section 返回 null）
   │  └─ DeviceConnectionPanel（设备命令订阅 + 列表/反馈）
   ├─ ReadOnlyConfigPanel（resource/instance 说明 + 头部打开目录）
   ├─ ConfigDirectoryPanel（目录 Query + 打开目录）
   └─ SettingsUpdatesPanel（卡片壳）
      ├─ AutoUpdateConfigPanel（自动更新草稿/保存）
      └─ ComponentUpdatePanel（版本 Query + 更新命令/反馈）
```

- **页面无请求。** `ConfigManager` 不导入 API、Query、领域所有者或 localStorage，只组合工作区。
- **section 只有一份。** `SettingsWorkspace` 是唯一调用 `useConfigSection()` 的位置，也负责 `useFluidTabIndicator` 所驱动的分段导航。
- **连接面板始终挂载。** `ConnectionConfigPanel` 在所有 section 下保持组件挂载，只在 connection 时渲染 Card；因此切换 section 不重建 `settings/maa-config` Query 观察者，也不清空草稿、保存 loading 或读取/保存反馈。
- **设备面板按 section 挂载，命令不随 section 取消。** `DeviceConnectionPanel` 只在自己的可见子树内订阅 `DeviceConnectionOwner`；切到只读 section 会卸载面板 DOM，但 owner 继续持有在途命令与已完成结果，恢复 connection 后从 owner 读取最新状态。
- **更新用例分成两个面板。** `SettingsUpdatesPanel` 只提供卡片壳；`AutoUpdateConfigPanel` 订阅 `AutoUpdateConfigOwner`，`ComponentUpdatePanel` 订阅版本 Query 与 `SettingsUpdateOwner`。自动更新草稿/保存状态不会重渲染组件更新按钮，组件更新/版本状态也不会重渲染自动更新表单。
- **目录 Query 由两个入口共享，第二个观察者只读缓存。** 目录卡片与只读 section 头部共享同一 `settings/config-directory` Query；只读头部使用 `useSettingsConfigDirectory({ cacheOnly: true })`，显式 `refetchOnMount: false`、`retryOnMount: false`。因此切到 resource/instance 不会重取、失败后不会自动重试，也不会把目录卡片的错误/重试临时换成“正在读取目录...”。加载与重试仍只由目录卡片观察者负责。

订阅隔离（渲染边界的验收依据）：

| 状态变化 | 会重渲染 | 不会重渲染 |
| --- | --- | --- |
| connection 草稿编辑 | `ConnectionConfigPanel`、其内的设备面板（adb 路径/地址 props） | 更新卡片内两个面板、`ConfigDirectoryPanel` |
| 设备发现/连接测试状态 | `DeviceConnectionPanel` | `ConnectionConfigPanel` 的表单、更新/目录面板 |
| 版本读取/重取 | `ComponentUpdatePanel` | 连接、设备、目录、自动更新面板 |
| 组件更新命令状态 | `ComponentUpdatePanel` | 连接、设备、目录、自动更新面板 |
| 自动更新草稿/保存状态 | `AutoUpdateConfigPanel` | 连接、设备、目录、组件更新面板 |
| 配置目录状态 | `ConfigDirectoryPanel`、可见的 `ReadOnlyConfigPanel` | 连接、设备、更新卡片内面板 |

`ConfigManager.subscriptions.test.tsx` 用领域 hook 的调用次数作为面板渲染次数的代理，覆盖“设备/更新状态不驱动连接表单”和“草稿编辑不驱动更新/目录面板”。各面板只从 `useStatusStore` 选择 `setMessage` 动作，不订阅全局消息正文，因此更新/设备产生的全局提示也不会重渲染连接表单。

### 3. Section 与草稿生命期

| 状态 | 所有者 | section 切换 | Activity 隐藏/恢复 | 真正卸载/刷新 |
| --- | --- | --- | --- | --- |
| 当前 section | `useConfigSection` | 写存储并更新状态 | Effect 清理后恢复时重新订阅 | 从存储恢复 |
| connection 草稿/revision | `ConnectionConfigOwner` | 保留 | 保留 | 保留（模块级 owner） |
| connection Query 快照 | `settings/maa-config` Query | 观察者保持 | 观察者注销/恢复 | 缓存按新鲜度重取 |
| 连接保存 loading 与反馈 | `ConnectionConfigPanel` 本地状态 | 保留 | 保留 | 清空 |
| 设备列表/测试反馈 | `DeviceConnectionOwner` | 保留 | 保留已完成结果 | 保留（未完成已取消） |
| 目录路径/状态 | `settings/config-directory` Query | 保留（共享缓存） | 观察者注销/恢复 | 按新鲜度重取 |
| 版本 | `settings/version` Query | 保留 | 观察者注销/恢复 | 按新鲜度重取 |
| 自动更新草稿/dirty/反馈 | `AutoUpdateConfigOwner` | 保留 | 保留；初始化标记阻止重读 | 保留；重挂载会重读，未保存草稿不被覆盖 |
| 更新命令状态/反馈 | `SettingsUpdateOwner` | 保留 | 保留；命令继续完成 | 保留 |

- 保存进行中切到只读 section：保存继续在 owner 中执行，返回 connection 后仍能看到 `superseded`/失败反馈与最新草稿。
- 切换 section 会替换编辑器 Card 的 DOM（连接与只读是两个独立面板），但草稿、Query 快照与保存反馈不随之销毁；默认态三个 section 的渲染结构与此前一致。
- `Resource`/`Instance` 之间切换复用同一个只读面板，只更新标题与说明。

### 4. 设备命令的取消边界

设备命令的取消仍属于页面/Activity 生命周期，而不是面板可见性：

- `useSettingsDeviceConnection()` 只订阅 owner 并转发动作，不再在自身 Effect cleanup 中取消命令。
- `SettingsWorkspace` 调用 `useDeviceConnectionActivityCleanup()`，在 Activity 隐藏或页面真正卸载时执行 `cancelAll()`。
- 因此切换到只读 section 不会中断在途查找/测试；设备面板重新显示时读取 owner 的最新结果，不自动重发。
- 地址输入变更仍只清除旧测试反馈，不取消在途测试。

### 5. 错误反馈的归属

| 反馈 | 渲染位置 | 来源 |
| --- | --- | --- |
| 连接读取/保存失败、`superseded` 警告 | `.config-editor-card` 内 | `ConnectionConfigPanel` 本地反馈 + owner 结果 |
| 设备查找/连接测试失败 | 设备分组内 | `DeviceConnectionOwner.discovery/test` |
| 目录读取失败与重试 | 目录卡片内 | `config-directory` Query 状态 |
| 自动更新读取/保存/调度失败 | 更新卡片自动更新分组 | `AutoUpdateConfigOwner` |
| 组件更新失败与资源重试 | 更新卡片底部 | `SettingsUpdateOwner` |

各面板只渲染自己的反馈；一个用例的失败不会写入另一个面板的页内状态。全局状态消息仍由各面板在明确结果后调用 `useStatusStore`。

### 6. 兼容与维护约束

- Query key、读取时机、失效作用域、失败保旧、设备命令 wire、更新顺序与自动更新本地键均未变。
- 保持默认 connection 页面、resource 与 instance 只读页面的 DOM、标签关联与视觉约束；section 切换和只读入口由下列回归测试覆盖。
- 唯一可见的生命期差异：section 切换不再卸载设备 hook，而是卸载设备面板；在途命令不取消（与迁移前语义一致），恢复后从 owner 显示结果。

## 配置编辑与保存

配置读取走 `settings/maa-config` Query，草稿与保存由 `features/settings/model/connectionConfig.ts` 的模块级所有者持有。

设备发现、连接测试、版本、配置目录与打开目录由设置设备领域负责，见[设置设备连接与系统资源](#设备连接与系统资源)；组件更新与自动更新由 `model/updateCommands.ts`、`model/autoUpdateConfig.ts` 及其 hooks 持有，见[设置组件更新与自动更新](#组件更新与自动更新)。自动更新的归一化模型仍在 `model/configNormalization.ts`，草稿、提交与调度状态机归自动更新所有者。

验证入口见文末[回归测试](#回归测试)。

### 1. 定位与边界

| section | 可编辑 | 服务端资源 | 保存 / 重置 |
| --- | --- | --- | --- |
| `connection` | 是 | `settings/maa-config` Query + `ConnectionConfigOwner` 草稿 | 显式保存；重置只改草稿 |
| `resource` | 否 | 配置目录等只读说明（读取见[设置设备连接与系统资源](#设备连接与系统资源)） | 不渲染保存/重置 |
| `instance` | 否 | MAA 管理的实例选项 | 不渲染保存/重置 |

归属：

| 能力 | 所有者 | 不负责 |
| --- | --- | --- |
| 服务端只读快照、取消与重试 | `settings/maa-config` Query（`model/connectionConfig.ts`） | 草稿合并、保存时机 |
| 草稿、revision、迟到读取裁决、保存去重与结果 | `ConnectionConfigOwner` | 服务端事务、跨客户端条件写 |
| section 选择、存储键、window 事件与清理 | `model/configSection.ts` + `hooks/useConfigSection.ts` | 配置读取或保存 |
| 页面反馈、保存按钮 loading、section 面板组合 | `components/ConnectionConfigPanel.tsx`、`SettingsWorkspace`、`ConfigSectionNav` | 再维护一份 revision 或草稿副本 |

`resource` 与 `instance` 没有可写入口；切到只读 section 不影响 connection 草稿，也不触发服务端读取。`connection` 的保存进行中切换到其它 section 时保存继续执行，返回后草稿与反馈仍然有效。

### 2. 读取与草稿

#### 2.1 Query 身份与载荷

`maa-config` 的 profile 参数与 Query key 以[Query 缓存与键规范](../../architecture/query-cache.md)为准。

- Query 只保存服务端只读快照，不直接写页面；`queryFn` 把 Query 的 `AbortSignal` 传给 `getConfig(profileName, signal)`，Activity 隐藏或卸载时由 Query 取消观察并按既有策略保留缓存。
- `getConfig` 收紧载荷校验：`adb_path`、`address`、`config` 出现时必须是字符串，`auto_reconnect` 出现时必须是布尔；已知字段类型不合法返回 `INVALID_DOMAIN_PAYLOAD`。缺失字段是合法的 MAA profile 形态，由归一化模型补页面默认值。
- 归一化保留 `connection` 段中的未知字段，保存时随快照原样回写；已知字段缺失或类型不合法时使用页面原有默认值（`/opt/homebrew/bin/adb`、`127.0.0.1:16384`、`CompatMac`、自动重连开启）。
- Query 默认策略与失败分类沿用[Query 缓存与键规范](../../architecture/query-cache.md)。

#### 2.2 草稿状态

`ConnectionConfigOwner` 是模块级对象，寿命不跟随页面、section 或 Activity：

| 字段 | 含义 |
| --- | --- |
| `draft` | 当前可编辑草稿；包含服务端未知 connection 字段 |
| `persisted` | 最近一次服务端读取采用或成功保存的值 |
| `revision` | 草稿可观察版本；编辑、重置、采用服务端值、保存成功都会推进 |
| `dirty` | `draft` 与 `persisted` 是否存在差异 |
| `syncState` | `idle` / `saving` / `failed` |
| `error` | 最近一次保存失败的原始原因 |
| `loaded` | 是否已成功采用服务端读取或完成一次保存 |
| `lastSavedAt` | 最近一次保存成功的时间戳 |

#### 2.3 迟到读取与 refresh

一次读取开始时 owner 记录 `{ revision, dirty, saving }` 快照；Query 返回时只有以下条件全部满足才采用服务端值：

1. 读取开始后没有新编辑、重置或保存（`revision` 未变）；
2. 读取开始时没有未保存草稿（`dirty=false`）；
3. 读取开始时没有保存在途（`saving=false`）；
4. 当前没有保存在途，也没有未保存草稿。

因此：

- **初始加载期间的编辑优先**：加载在途时编辑会推进 revision，迟到的初始响应被丢弃。
- **refresh 不覆盖编辑**：重新读取（remount、失效后的重取或显式重新读取）在草稿未保存时不会改页面值；草稿干净时才采用服务端快照。
- **保存前发出的读取不会回滚保存**：保存成功会推进 revision，使保存前开始的读取即使更晚返回也失效。
- **重置后不会被旧读取带回服务端值**：重置即使内容未变也推进 revision。

页面把 Query 快照交给 owner 裁决（`adoptServer(snapshot)`），不直接把 `query.data` 写进表单。

#### 2.4 保存

保存是显式动作，wire 不变：`POST /agent/config/maa/:profileName`，请求体 `{ connection: snapshot }`。

- 同一时刻只允许一次保存；保存中再次调用返回 `ignored`，页面不重复提示。
- 保存期间仍可编辑。响应返回时只有 revision 未变才把当前草稿视为已保存；否则返回 `superseded`，页面提示“此前连接配置已保存，当前更改尚未保存”，并保留新草稿。
- 保存成功清除 dirty、更新 `persisted` 与 `lastSavedAt`，并推进 revision 使保存前的读取失效；保存失败保留草稿与 `failed`/`error`，下一次保存重试同一份最新草稿。
- 服务端只返回成功信封，不回写 profile；页面按已发送快照确认，不伪造服务端归一化结果。

#### 2.5 重置

“重置”只把草稿恢复为页面原有默认值：

- 不调用保存端点；用户下一次显式“保存”才写入服务端；
- 保存进行中时忽略重置；
- 重置推进 revision，使重置前发出的读取不能把服务端旧值带回；
- 重置会丢弃从服务端读取到的未知 connection 字段（恢复的是完整默认快照），与迁移前的重置行为一致。

#### 2.6 读取失败

初始读取失败（尚无 Query 数据）沿用迁移前的页内 `role="alert"` 与全局状态消息：`连接配置读取失败: <原因>`。已有服务端数据后的后台 refresh 失败不打断编辑，也不重复写全局消息。读取成功后清除对应的初始失败提示。

### 3. Section 状态与清理

| 项目 | 值 / 行为 |
| --- | --- |
| 存储键 | `laPlumaConfigSection`（兼容键，不改名） |
| window 事件 | `la-pluma-config-section`，`detail` 为 `connection`/`resource`/`instance` |
| 初始值 | 读取存储；缺失或非法值回退 `connection` |
| 点击 section | 写存储并更新页面状态 |
| 外部事件 | 校验 `detail`，写存储并更新页面状态；非法 detail 忽略 |
| 清理 | `useConfigSection` 在 Effect cleanup 中注销 window 监听；Activity 隐藏/恢复与真正卸载都会清理并重新订阅 |

`model/configSection.ts` 是这些常量的唯一所有者；`useConfigSection.ts` 只负责 React 订阅。页面不再自己读 `localStorage`、注册 `la-pluma-config-section` 监听或持有 `setConfigType`。

section 只控制渲染哪个面板：`ConnectionConfigPanel` 在所有 section 下保持挂载，只在 connection 时渲染 Card；`settings/maa-config` Query 与草稿订阅因此不随 section 切换重建，也不重读服务端或清空草稿。`resource`/`instance` 的能力由 `isEditableConfigSection()` 明确为只读，保存/重置按钮只在 connection 渲染。面板组合与订阅边界见[设置领域面板](#页面与面板)。

### 4. 面板接线

- `ConfigManager` 只组合 `SettingsWorkspace`；section 导航、页头与网格由工作区渲染。
- `useSettingsConnectionConfig()` 返回 `draft`、`dirty`、`syncState`、`error`、`loaded`、`loadError`、`update`、`restoreDefaults`、`save`、`reload`；`ConnectionConfigPanel` 只渲染表单、按钮 loading 与反馈。
- 页面删除的职责：`configData` state、`loadConfig()`、`connectionRevisionRef`、`connectionSaveInFlightRef`、section `localStorage` 读写与 window 监听。
- 输入、平台配置与自动重连开关都通过 `update(patch)` 写入 owner；编辑清空页内反馈与保存错误。
- 保存按钮 loading 取 `syncState === 'saving'`，重置按钮在保存中禁用；保存结果按 `saved`/`superseded`/`failed` 分别提示。
- 自动更新的读取/本地回退、touched/revision、保存后 `setupAutoUpdate` 与反馈由 `AutoUpdateConfigOwner` 和 `useSettingsAutoUpdate()` 持有；归一化与时间校验仍在 `model/configNormalization.ts`，见[设置组件更新与自动更新](#组件更新与自动更新)。
- 设备发现、连接测试、版本、配置目录与打开目录归[设置设备连接与系统资源](#设备连接与系统资源)；组件更新与自动更新归[设置组件更新与自动更新](#组件更新与自动更新)。

### 5. 兼容与维护约束

- 端点、请求体、响应体与服务端 TOML 写入方式未改变；配置 key、profile 名与 section 存储键/事件名保持不变。
- Query 快照只存在于内存，浏览器刷新随缓存丢失；key 与参数清单见[Query 缓存与键规范](../../architecture/query-cache.md)。没有新增 localStorage 数据。
- 载荷校验比迁移前严格：已知字段类型不合法时整份读取失败并显示错误，而旧页面会把异常值放入受控输入。未知 connection 字段仍原样保留。
- 已知字段缺失时显示页面默认值，而旧页面会显示空输入；这是归一化模型的要求，正常服务端载荷（`getConfig` 自带默认值）不受影响。
- 默认渲染结构、DOM 与 CSS 未改变；失败/`superseded` 提示只在非默认状态出现，视觉基线不因该逻辑调整更新。

## 设备连接与系统资源

设备发现/连接测试是带副作用的显式命令，由模块级 `DeviceConnectionOwner` 持有；版本与配置目录是只读资源，由 `settings/version`、`settings/config-directory` Query 持有。connection 草稿与保存见[设置配置编辑与保存](#配置编辑与保存)，Query 通用策略见[Query 缓存与键规范](../../architecture/query-cache.md)，请求取消与失败分类见[资源请求错误与取消契约](../../architecture/resource-requests.md)。

### 1. 定位与边界

| 能力 | 唯一所有者 | 形态 | 不负责 |
| --- | --- | --- | --- |
| 设备发现 | `features/settings/model/deviceConnection.ts` 的 `DeviceConnectionOwner` | 显式命令 `GET /agent/actions/discover-devices?adbPath=…`；不进入 Query | 保存连接配置 |
| 连接测试 | 同一 owner 的 test 链 | 显式命令 `POST /agent/actions/test-connection`；不进入 Query | 写草稿、写 profile |
| 版本读取 | `features/settings/model/systemResources.ts` 的 `versionQueryOptions()` | `settings/version` Query | 更新命令 |
| 配置目录读取 | 同文件的 `configDirectoryQueryOptions()` | `settings/config-directory` Query | 打开目录 |
| 打开配置目录 | `features/settings/hooks/useSettingsConfigDirectory.ts` 的 `open()` | 显式命令 `POST /agent/actions/open-config-directory` | Query、自动重取 |
| 页面反馈与按钮 loading | `components/DeviceConnectionPanel.tsx`、`ConfigDirectoryPanel.tsx`、`ReadOnlyConfigPanel.tsx` | 只渲染 owner/Query 状态 | 命令状态机、请求取消 |

设备发现会探测本机 ADB 与常见模拟器端口，连接测试会尝试 `adb connect`；两者在 Agent 契约中属于低风险写入，不应做成可自动重取的只读 Query。打开配置目录同样有副作用，只保留显式入口。

### 2. 设备发现与连接测试

#### 2.1 独立状态机

`DeviceConnectionOwner` 公开两条互不影响的命令链：

| 状态 | 含义 |
| --- | --- |
| `discovery.phase` | `idle` / `running` / `succeeded` / `failed` / `cancelled`；只控制“查找模拟器”按钮的 loading |
| `discovery.devices` | `devices` 与 `candidates` 按响应顺序拼接；查找进行中保留上一次列表 |
| `discovery.message` | 可直接展示的提示；服务端 `message` 或本地失败说明 |
| `discovery.error` | 请求失败或内层 `success=false` 的原因；成功与取消为 `null` |
| `discovery.searched` | 是否完成过一次查找；取消不算完成，页面据此显示空结果提示 |
| `test.phase` | 同上的测试生命周期；只控制“测试连接”与设备行按钮 |
| `test.address` / `test.success` / `test.message` | 最近一次测试目标与连接结果；未建立连接但请求完成时 `error=null` |
| `test.draftRevision` | 发起测试时的草稿 revision |
| `test.superseded` | 测试期间草稿已推进；结果仍展示，但不代表当前表单目标 |

规则：

- 两条链各自只有一次在途请求。重复发起同一类操作会 `abort()` 旧请求；旧响应不写状态，返回 `cancelled`。
- 一个操作的进行或失败不改写另一个操作的 loading。查找开始会清空连接测试的页内反馈：已结束的测试回到 `idle`，在途测试保持 `running` 且不被取消；连接测试完成仍会在查找进行中写入自己的结果（迁移前行为）。
- 取消不展示为失败。`AbortError` 不写入 `message`/`error`；`phase` 变为 `cancelled`。
- 取消查找不把 `searched` 置为 true；从未完成过查找时，取消后恢复页面不会出现伪造的“未找到设备”（此前已完成过查找时空结果提示保持迁移前行为）。
- 设备行只接受非空 `address`；未知 `state`/`source` 分别回退 `unknown`/`adb`，坏条目跳过，不再像迁移前那样在非数组载荷上抛错。
- 内层 `success=false`（例如 ADB 不可用）是领域失败：`phase=failed`、`error`/`message` 取服务端文案，载荷中归一后的设备仍会展示（服务端通常返回空数组）；HTTP/API 信封失败清空设备；传输失败使用 `查找设备失败: <原因>`。连接测试的请求失败使用 `连接测试失败: <原因>`。
- 连接未建立（`success=false` 但请求完成）仍是已完成的测试结果：`phase=succeeded`、`test.success=false`，页面沿用 `status-danger` 反馈。

#### 2.2 选择发现结果与草稿版本

选择设备时：

1. 读取**点击时**的最新草稿；设备自带 `adbPath`（Windows 模拟器内置 ADB）时使用它，否则沿用最新草稿的 `adb_path`。
2. 通过 `ConnectionConfigOwner.update()` 只合并 `adb_path`/`address` 两个字段，保留服务端未知字段、其它草稿字段与点击前的最新编辑。草稿内容未变化时不推进 revision。
3. 记录更新后的草稿 revision 并启动连接测试；测试响应从不写草稿。

因此测试期间继续编辑地址、平台配置或自动重连不会被旧测试结果覆盖；`test.superseded` 会标记该结果不再对应当前目标。地址输入变更只清除旧反馈，不取消在途测试（迁移前行为）。

#### 2.3 Activity 与取消

`useSettingsDeviceConnection()` 只做订阅与动作转发；取消动作由 `SettingsWorkspace` 的 `useDeviceConnectionActivityCleanup()` 在 Effect cleanup 中调用：

- Activity 隐藏或页面卸载会 abort 两条链的本地等待；不会调用服务端停止接口，也不撤销已发生的探测/`adb connect`。
- section 切换不触发取消：设备面板会随 connection section 卸载/挂载，但在途请求继续，结果写入模块级 owner，恢复 connection 后显示。
- 已完成的结果保存在模块级 owner 中，恢复后继续展示；不自动重发，用户可再次查找或测试。
- hook 恢复时重新订阅；真正卸载后 owner 仍是同一实例，未完成请求已被取消，不会在后台回填页面。

### 3. 版本与配置目录

#### 3.1 Query 身份与归一化

版本与配置目录的 Query key、默认策略以[Query 缓存与键规范](../../architecture/query-cache.md)为准。

- `versionQueryOptions()` 把 Query 的 `AbortSignal` 传给 `getVersion(signal)`，只接受 `cli`/`core`/`raw` 为字符串；坏的 `resource` 块被归一为 `unknown` 状态与空字段，缺失 `resource` 时页面不显示资源行。不可用载荷成为 `contract` 失败。
- `configDirectoryQueryOptions()` 把 signal 传给 `getConfigDir(signal)`，同时接受服务端当前的 `{ path }` 与旧的纯字符串形状；空白路径视为 `contract` 失败。`getConfigDir` 的返回类型因此从 `ApiResponse<string>` 修正为 `ApiResponse<string | { path: string }>`，与运行时的旧字符串/对象两种形状一致。
- 两者沿用 Query 默认重试与取消策略；传输失败会先经过重试，之后才显示初始目录错误，与 connection 读取一致。

#### 3.2 页面语义

- 版本读取失败保持静默（迁移前行为）；页面继续渲染其余内容。更新成功后的版本同步由设置域更新命令调用 `useSettingsVersion().reload()`，其内部 `invalidateQueries` 同一 `settings/version`：页面可见时立即重取，隐藏时恢复显示后重取，见[设置组件更新与自动更新](#组件更新与自动更新)。
- 配置目录首次读取中显示“正在读取目录...”；从未成功读取且失败时显示 `配置目录读取失败: <原因>` 与“重试”按钮，重试走 `refetchQueries` 同一 key。
- 后台刷新失败保留最近一次成功路径；只有从未成功读取过才显示错误，避免 Activity 恢复后的后台失败清空可用路径。
- 打开目录有两个原有入口：只读 section 的卡片头按钮与配置目录卡片按钮。两者都调用 `useSettingsConfigDirectory().open()`；成功提示“已打开配置目录”，失败提示 `打开失败: <原因>`，不触发 Query 重取。
- section 切换不取消在途设备命令，也不清空设备列表、测试反馈、版本与目录路径；设备面板随 connection section 卸载/挂载，但状态保存在模块级 owner 与 Query 缓存中。设备命令的取消只由 Activity 隐藏或页面真正卸载触发（`SettingsWorkspace` 的 `useDeviceConnectionActivityCleanup`），不是面板可见性。
- 配置目录的只读 section 头部观察者只复用缓存：`useSettingsConfigDirectory({ cacheOnly: true })` 显式关闭 `refetchOnMount` 与 `retryOnMount`，切 section 不产生新请求，失败后也不自动重试；目录卡片的观察者保持默认策略，加载与重试入口仍只在那里。

### 4. 面板接线与遗留清理

`ConfigManager` 只组合 `SettingsWorkspace`；设备发现、连接测试、版本、配置目录与打开目录由 hooks 持有，当前分别由设备、更新与目录面板订阅。`ConfigManager` 与各面板都不直接导入 `discoverDevices`、`testConnection`、`getVersion`、`getConfigDir`、`openConfigDir`，也不保存设备列表、查找/测试 loading、测试反馈、版本、目录路径/状态/错误的页面 state。对这些资源，面板只保留渲染与全局状态提示；组件更新与自动更新由 模块级所有者持有，见[设置组件更新与自动更新](#组件更新与自动更新)。

| 页面原职责 | 新归属 |
| --- | --- |
| `handleDiscoverDevices` / `handleTestConnection` / `handleUseDiscoveredDevice` | `DeviceConnectionPanel` → `useSettingsDeviceConnection()` 动作 |
| 设备列表、查找提示、`hasSearchedDevices`、`discoveringDevices` | `DeviceConnectionOwner.discovery` |
| 测试 loading 与 `connectionFeedback` | `DeviceConnectionOwner.test` |
| `loadVersion` 与 `versionInfo` state | `SettingsUpdatesPanel` → `useSettingsVersion()` + `settings/version` |
| `loadConfigDir`、目录三态与重试 | `ConfigDirectoryPanel` / `ReadOnlyConfigPanel` → `useSettingsConfigDirectory()` + `settings/config-directory` |
| `handleOpenConfigDir` 的 API/错误分支 | `useSettingsConfigDirectory().open()`；目录卡片与只读 section 头部共享同一命令 |

自动更新与 core/cli/资源更新归 `model/autoUpdateConfig.ts`、`model/updateCommands.ts` 及其 hooks，见[设置组件更新与自动更新](#组件更新与自动更新)；更新成功后的版本读取走同一 Query。

### 5. 兼容与维护约束

- 端点、请求体与响应体未改变；未修改服务端。设备发现仍是 GET、连接测试与打开目录仍是 POST。
- 新增 Query key 只存在于内存，浏览器刷新随缓存丢失；没有新增 localStorage 数据。
- 默认渲染结构、DOM、CSS 与文案未改变；失败/取消状态仍走原有提示区域，视觉基线不因该逻辑调整更新。
- 行为差异：
  - 设备发现与连接测试请求现在在 Activity 隐藏/卸载时 abort；迁移前会继续完成并写页面 state。section 切换不取消命令（与迁移前一致），但设备面板会卸载并在恢复 connection 后从 owner 读取结果。
  - 非数组/坏设备条目被跳过而不是抛错；未知状态/来源回退为“状态未知”/ADB。
  - 配置目录后台刷新失败保留最近成功路径；迁移前显式重读失败会清空路径。
  - 版本 `resource` 块按已知字段归一；坏字段显示 `unknown`，不再把任意对象直接传入渲染。
  - 传输失败按 Query 默认重试，错误提示在重试结束后显示。

## 组件更新与自动更新

版本资源的 Query 身份见[设置设备连接与系统资源](#设备连接与系统资源)，配置编辑见[设置配置编辑与保存](#配置编辑与保存)，失效端口见[共享资源归属与失效端口](../../architecture/resource-ownership.md)。

### 1. 定位与边界

| 能力 | 唯一所有者 | 形态 | 不负责 |
| --- | --- | --- | --- |
| core 更新 / 渠道切换 / CLI 更新 / 资源热更新 | `features/settings/model/updateCommands.ts` 的 `SettingsUpdateOwner` | 显式 POST 命令；共用一条在途槽位；不进入 Query | 版本读取、跨域失效发布 |
| 更新后的版本同步 | `features/settings/hooks/useSettingsUpdates.ts` 调用 `useSettingsVersion().reload()` | 后者 `invalidateQueries` 同一 `settings/version` | 伪造版本快照 |
| 更新后的跨域失效 | 同一 hook | 成功确认后推进物品图标 epoch，并按[失效端口](../../architecture/resource-ownership.md)发布（`cause: resource-update`） | 清空 Query 缓存、轮询 |
| 自动更新策略草稿与完整提交 | `features/settings/model/autoUpdateConfig.ts` 的 `AutoUpdateConfigOwner` | 模块级草稿；保存 = 写 user config + 应用调度 | 定时任务本身的执行 |
| 自动更新归一化与时间校验 | `features/settings/model/configNormalization.ts` | 纯函数 | 草稿生命周期 |
| 页面反馈、按钮 loading、反馈渲染 | `components/AutoUpdateConfigPanel.tsx`、`components/ComponentUpdatePanel.tsx` | 只渲染 owner 状态 | 再维护 update/auto-update 草稿 |

四条更新命令与自动更新保存都是**写入**：没有 Query mutation、没有自动重试，也没有 AbortSignal。用户取消页面或 Activity 隐藏只停止观察，不会撤销已提交的写入。

### 2. 组件更新命令

#### 2.1 互斥与生命周期

`SettingsUpdateOwner` 只有一个 `running` 槽位：

| 状态 | 含义 |
| --- | --- |
| `running: 'core'` | 普通 core 更新（不传版本，服务端 `maa update` 并同步资源） |
| `running: 'core-channel'` | 切换到 Beta/正式版（`install <channel> --force` 并同步资源） |
| `running: 'cli'` | CLI 更新 |
| `running: 'resources'` | 仅同步游戏资源 |
| `running: null` | 空闲 |

规则：

- 任意一条命令运行期间再次发起（含同一命令）返回 `status: 'ignored'`，不发第二个请求；页面据此禁用全部更新按钮，只让实际运行的按钮显示 loading。
- 开始运行时清空页内反馈（CLI 更新除外）；失败返回 `failed`，成功返回 `succeeded`。
- 命令失败不自动重发。core/资源热更新在部分失败时把 `resourceRetry` 置为 true，页面显示“重试资源同步”按钮；该按钮调用资源热更新，仍是用户显式动作。
- 寿命不跟随页面：Activity 隐藏或页面重挂载不取消在途命令；完成后仍写 owner 状态并更新全局提示。

#### 2.2 失败与重试条件

| 结果 | 页内反馈 | 全局提示 | 资源重试入口 |
| --- | --- | --- | --- |
| core / 渠道切换成功 | success，`result.message` 或 `MaaCore 和资源已更新` | 同一文案 | 否 |
| core / 渠道切换失败，`errorInfo.details`（兼容旧 `error.details`）的 `failedStep === 'resources'` 或 `coreUpdated === true` | error | 服务端文案 | 是 |
| core / 渠道切换失败，其它路径 | error | 服务端文案 | 否 |
| CLI 成功 | 不产生页内反馈（保留此前的更新反馈） | `MAA CLI 更新成功` | 否 |
| CLI 失败 | 不产生页内反馈 | `更新失败: <原因>` | 否 |
| 资源热更新失败（含内层失败、网络失败） | error | 服务端/本地文案 | 是 |
| 网络异常 | error（CLI 除外） | `网络错误: <原因>` | 资源热更新为是 |

渠道切换目标由 `resolveCoreChannelSwitch(currentCore)` 决定：版本字符串包含 `beta`/`alpha` 时切到正式版，否则切到 Beta；版本尚未读取时默认 Beta。成功文案使用 `Beta`/`正式版` 标签。

### 3. 成功后的版本与资源失效

更新命令确认成功后，React 适配层执行三项副作用：

1. **物品图标缓存版本**：资源变化成功后调用 `invalidateItemIconCache()`，推进并持久化 `laPlumaItemIconVersion`；`getItemIconUrl()` 使用 `?v=<epoch>`，训练/统计页通过 `useItemIconCacheVersion()` 重新渲染，避免浏览器继续命中同一路径的旧图。CLI 更新不推进。
2. **版本失效**：调用 `useSettingsVersion().reload()`，其内部 `queryClient.invalidateQueries({ queryKey: settingsKeys.query('version') })`。页面可见时立即重取；Activity 隐藏时 Query 没有观察者，失效标记保留，恢复显示后按 `refetchOnMount` 重新读取，不会被默认新鲜期挡住。
3. **资源失效**：core 更新、渠道切换与资源热更新按[共享资源归属与失效端口](../../architecture/resource-ownership.md)发布，`cause: 'resource-update'`。CLI 更新只改变 CLI 版本，不发布资源失效，也不推进图标 epoch。

完成提示（成功或失败）在命令 HTTP 返回后立即发出，资源失效与版本重取随后执行；按钮在命令返回时恢复可点，早于版本重取结束（迁移前的 loading 会覆盖到版本重取完成）。因此用户立即发起第二条命令时，其开始提示不会被第一条的成功提示覆盖。

图标 epoch 由本客户端发起的手动更新推进；服务端定时自动更新或其他客户端触发的资源变化不会主动通知本标签页，需等待浏览器缓存过期或本客户端下一次手动更新。干员头像仍是各页面直接构造的独立 URL，不在该机制内。

跨域作用域与接收方映射以[共享资源归属与失效端口](../../architecture/resource-ownership.md)为准。图标 epoch 是独立的本地缓存标记，由 `useItemIconCacheVersion()` 推动使用图标的组件重渲染；识别快照与掉落不由资源更新重写。

失败与取消不发布失效，也不重取版本以外的资源。失效只标记/重取明确受影响的 key，不调用 `queryClient.clear()`，不整体清空无关缓存。

### 4. 自动更新策略

#### 4.1 读取与本地回退

`AutoUpdateConfigOwner.load()`：

1. 读取服务端 `auto-update` 用户配置并归一化。成功且载荷可归一化时采用，`dirty=false`，清空此前的读取/保存反馈，并把该副本写入 `autoUpdateConfig` 本地键（编辑过的草稿不采用、不覆盖）。
2. 服务端失败时读取本设备上次保存的 `autoUpdateConfig`：可归一化时作为草稿（`dirty=true`），并给出 warning。服务端错误存在时文案为 `自动更新设置读取失败: <原因>，已显示此设备上次保存的设置，请保存后重试`；否则为 `已载入此设备上次保存的自动更新设置，请保存后应用`。
3. 本地 JSON 损坏时给出 `自动更新设置读取失败: <解析原因>`，不伪造草稿。
4. 服务端成功但载荷不可归一化时按“无服务端错误”走本地回退；没有本地草稿且无服务端错误时保持默认值、不提示。

读取守卫：`load()` 记录开始时的 revision 与 touched；读取期间出现编辑（revision 推进、touched=true）或确认保存（revision 推进）时，迟到响应不写草稿。页面每次真正挂载读取一次；Activity 隐藏/恢复不重读（hook 的初始化标记随页面 state 保留），真正重挂载会重读：未保存草稿不会被覆盖，确认保存后的读取可以重新采用服务端副本（例如其它客户端已更新）。

#### 4.2 草稿与保存

任意 `update(patch)` 都：

- 合并当前草稿，`dirty=true`，清空页内反馈；
- 推进本地 revision；
- 立即把草稿写入 `autoUpdateConfig` 本地键（本设备 fallback，不代表服务端已确认）。

保存是完整提交，同一时刻只有一次：

1. `enabled && time` 不是 `00:00–23:59` 的 `HH:MM` 时直接返回 `invalid`，不调用任何端点。
2. `saveUserConfig('auto-update', config)`。失败返回 `failed`，不调用调度接口，保留草稿与 dirty。
3. `setupAutoUpdate(config)`。`result.success` 且（禁用时或响应 data 的 `success !== false`）才算完整成功。
4. 完整成功且 revision 未变：写本地 fallback、清除 touched、推进 revision（使保存前发出的读取失效）、`dirty=false`、success 反馈（`自动更新已启用，每天 <time> 执行` / `自动更新已禁用`）。
5. 完整成功但保存期间出现新编辑：返回 `superseded`，保留新草稿与 dirty，提示“此前设置已保存，当前更改尚未保存”。
6. 配置已保存而调度失败：返回 `failed`，提示 `自动更新设置应用失败: <原因>`，配置不回滚，用户可再次保存重试。

保存期间允许继续编辑；Activity 隐藏或页面重挂载不会中断已提交的保存。owner 是模块级对象，保存完成后即使页面隐藏也会写入状态与全局提示。

### 5. 面板接线

`ConfigManager` 只组合 `SettingsWorkspace`；`SettingsUpdatesPanel` 只提供卡片壳，自动更新策略与组件更新分别由 `AutoUpdateConfigPanel`、`ComponentUpdatePanel` 订阅。两个面板都不导入 `loadUserConfig`、`saveUserConfig`、`updateMaaCore`、`updateMaaCli`、`hotUpdateResources`、`setupAutoUpdate`，也不保存更新/自动更新的页面 state：

| 页面原职责 | 新归属 |
| --- | --- |
| `updating` / `hotUpdating` / `updateInFlightRef` | `SettingsUpdateOwner.running` |
| `updateFeedback` 与资源重试条件 | `SettingsUpdateOwner.feedback` |
| core/渠道/CLI/资源命令与开始/结束提示 | `useSettingsUpdates()` |
| 更新成功后的版本重取 | `useSettingsUpdates()` 调用 `useSettingsVersion().reload()`（`invalidateQueries`） |
| 自动更新 `autoUpdate`/`dirty`/`saving`/`feedback`、touched/revision、本地回退、保存 + 调度 | `AutoUpdateConfigOwner` + `useSettingsAutoUpdate()` |
| 自动更新页内/全局提示 | owner 反馈；hook 转发到全局状态 |

按钮语义保持不变：core/资源按钮显示各自 loading，切换渠道按钮只禁用不 loading，CLI 按钮显示自己的 loading；全部更新按钮在任意命令运行期间禁用。默认渲染结构、DOM、CSS 与文案未改变。

### 6. 兼容与维护约束

- 端点、请求体、响应体未改变；未修改服务端。update-core 仍在不传版本时使用 `maa update`，切渠道传 `beta`/`stable`；auto-update 仍先写 user config 再 POST `configure-auto-update`。
- localStorage 键 `autoUpdateConfig` 的写入时机与内容不变（成功加载、每次编辑、保存成功）；新增 `laPlumaItemIconVersion`，只保存物品图标缓存 epoch，不保存业务配置。
- 无 Query key 新增；版本继续复用 `settings/version`；物品图标仍不进入 Query。
- 组件更新的图标缓存、版本同步与反馈时机见[成功后的版本与资源失效](#3-成功后的版本与资源失效)；自动更新草稿的读取、重挂载与保存裁决见[自动更新策略](#4-自动更新策略)。命令重试与生命周期以本专题第 2 节为准，Query 默认策略见[Query 缓存与键规范](../../architecture/query-cache.md)。

## 回归与关联

### 回归测试

| 文件 | 覆盖 |
| --- | --- |
| `client/src/pages/settings/ConfigManager.layout.test.tsx` | section 导航/存储/事件/清理、只读说明与入口、两个打开目录入口；初始读取失败、初始/refresh 不覆盖编辑、保存期间编辑/跨 section 保存、重置只改草稿、连接保存失败、Activity 保留草稿并重订阅；发现使用草稿 adb 路径/回填设备、查找与测试 loading 独立、失败反馈/重试、测试期间编辑不覆盖、隐藏取消而 section 切换不取消查找；版本/目录缓存复用、只读首屏一次目录读取、目录失败切只读不重试且保留重试入口；更新互斥、资源步骤失败重试、失败不发布/重试/推进图标 epoch、CLI 只重取版本、core/热更新发布四类失效并推进 epoch、提示先于重取、隐藏期间更新继续并在恢复重取版本；自动更新保存跨隐藏、迟到读取不覆盖编辑、保存/失败/调度失败边界；连接与更新反馈不串面板 |
| `client/src/pages/settings/ConfigManager.subscriptions.test.tsx` | 设备/更新/自动更新/版本状态与全局消息不重渲染连接表单；自动更新编辑不重渲染组件更新面板；连接草稿编辑不重渲染更新/版本/目录面板；设备/更新动作不重渲染目录面板；目录缓存变化不重渲染连接/更新面板 |
| `client/src/features/settings/components/ReadOnlyConfigPanel.test.tsx` | 只读头部复用过期目录缓存、不触发 getConfigDir；目录可用时“打开目录”保持可点 |
| `client/src/features/settings/api/index.test.ts` | `getConfig` signal、profile 载荷校验、非法已知字段拒绝与未知字段保留 |
| `client/src/features/settings/model/configNormalization.test.ts` | connection 默认值与非法字段回退、未知字段保留、整份草稿比较；auto-update 归一化与 `HH:MM` 校验 |
| `client/src/features/settings/model/connectionConfig.test.ts` | 初始状态、编辑 revision/dirty、服务端采用条件、编辑期间迟到读取、脏草稿读取、保存前读取失效、保存在途读取、保存串行、保存期间编辑、失败保留与重试、未知字段回写、重置边界与保存中忽略、`settings/maa-config` key/signal/contract 失败/信封失败 |
| `client/src/features/settings/model/configSection.test.ts` | 存储键与事件名、非法存储回退、写入不抛错、可编辑能力、合法事件过滤与注销 |
| `client/src/features/settings/model/autoUpdateConfig.test.ts` | 服务端采用与本地缓存、后续成功读取清空旧回退警告、迟到读取不覆盖编辑/保存、确认保存后重挂载采用服务端副本、服务端失败本地回退/无回退错误、坏载荷/JSON；dirty/revision/反馈清理、无效时间、保存与调度完整成功、禁用仍要求调度成功、保存失败不碰调度、内层调度失败、保存期间编辑返回 superseded、保存互斥、抛错与 reset |
| `client/src/features/settings/model/deviceConnection.test.ts` | 两条链初始/运行态、loading 互不影响、设备归一与坏条目、内层/信封/传输失败、取消与迟到响应、新请求取代旧请求、测试成功/未连接/请求失败、草稿 revision 与 `superseded`、选择回填保留未知字段与最新编辑、`cancelAll` 与 reset |
| `client/src/features/settings/model/systemResources.test.ts` | `version`/`config-directory` key、signal、版本与目录归一化、旧字符串目录、空白路径与坏载荷 contract 失败、信封失败 |
| `client/src/features/settings/model/updateCommands.test.ts` | 渠道目标策略、失败详情新/旧形状、资源重试条件、四条命令互斥与重复忽略、core/渠道/CLI/资源成功与失败文案、网络异常、CLI 不产生页内反馈、无自动重试、reset |
| `client/src/features/game-data/model/itemIconCache.test.ts` | 图标 epoch 初始值、持久化恢复、坏值回退、单调推进、存储不可用与订阅注销 |

视觉基线只覆盖默认 connection 页面，resource/instance 只读态不在截图内。仓库内保留只读文案/入口、目录失败切换与 section 切换的行为回归；完整只读标记结构仍依赖代码审阅。

### 验证命令

以下命令均在仓库根目录执行。

页面与面板：

```sh
pnpm --filter la-pluma-next-client exec vitest run src/features/settings src/pages/settings
```

完整客户端验证：

```sh
pnpm --filter la-pluma-next-client verify
```

组件更新与自动更新：

```sh
pnpm --filter la-pluma-next-client exec vitest run \
  src/features/settings/model/updateCommands.test.ts \
  src/features/settings/model/autoUpdateConfig.test.ts \
  src/pages/settings/ConfigManager.layout.test.tsx \
  src/features/game-data/model/itemIconCache.test.ts
```

完整验证与视觉回归入口见[开发指南](../../development/README.md)。

### 关联契约

- [Query 缓存与键规范](../../architecture/query-cache.md)
- [前端架构与所有权](../README.md)
- [资源请求错误与取消契约](../../architecture/resource-requests.md)
- [共享资源归属与失效端口](../../architecture/resource-ownership.md)
