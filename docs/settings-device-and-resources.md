# 设置设备连接与系统资源

> [← 返回文档索引](README.md)

本文描述 FPR-025 交付的设置页设备连接与系统资源边界：设备发现、连接测试、版本读取、配置目录读取与打开。设备发现/连接测试是带副作用的显式命令，由模块级 `DeviceConnectionOwner` 持有；版本与配置目录是只读资源，由 `settings/version`、`settings/config-directory` Query 持有。connection 草稿与保存见[设置配置编辑与保存](settings-config-editing.md)，Query 通用策略见[Query 缓存与键规范](query-cache.md)，请求取消与失败分类见[资源请求错误与取消契约](resource-requests.md)。

## 1. 定位与边界

| 能力 | 唯一所有者 | 形态 | 不负责 |
| --- | --- | --- | --- |
| 设备发现 | `features/settings/model/deviceConnection.ts` 的 `DeviceConnectionOwner` | 显式命令 `GET /agent/actions/discover-devices?adbPath=…`；不进入 Query | 保存连接配置 |
| 连接测试 | 同一 owner 的 test 链 | 显式命令 `POST /agent/actions/test-connection`；不进入 Query | 写草稿、写 profile |
| 版本读取 | `features/settings/model/systemResources.ts` 的 `versionQueryOptions()` | `settings/version` Query | 更新命令 |
| 配置目录读取 | 同文件的 `configDirectoryQueryOptions()` | `settings/config-directory` Query | 打开目录 |
| 打开配置目录 | `features/settings/hooks/useSettingsConfigDirectory.ts` 的 `open()` | 显式命令 `POST /agent/actions/open-config-directory` | Query、自动重取 |
| 页面反馈与按钮 loading | `components/DeviceConnectionPanel.tsx`、`ConfigDirectoryPanel.tsx`、`ReadOnlyConfigPanel.tsx` | 只渲染 owner/Query 状态 | 命令状态机、请求取消 |

设备发现会探测本机 ADB 与常见模拟器端口，连接测试会尝试 `adb connect`；两者在 Agent 契约中属于低风险写入，不应做成可自动重取的只读 Query。打开配置目录同样有副作用，只保留显式入口。

## 2. 设备发现与连接测试

### 2.1 独立状态机

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

### 2.2 选择发现结果与草稿版本

选择设备时：

1. 读取**点击时**的最新草稿；设备自带 `adbPath`（Windows 模拟器内置 ADB）时使用它，否则沿用最新草稿的 `adb_path`。
2. 通过 `ConnectionConfigOwner.update()` 只合并 `adb_path`/`address` 两个字段，保留服务端未知字段、其它草稿字段与点击前的最新编辑。草稿内容未变化时不推进 revision。
3. 记录更新后的草稿 revision 并启动连接测试；测试响应从不写草稿。

因此测试期间继续编辑地址、平台配置或自动重连不会被旧测试结果覆盖；`test.superseded` 会标记该结果不再对应当前目标。地址输入变更只清除旧反馈，不取消在途测试（迁移前行为）。

### 2.3 Activity 与取消

`useSettingsDeviceConnection()` 只做订阅与动作转发；取消动作由 `SettingsWorkspace` 的 `useDeviceConnectionActivityCleanup()` 在 Effect cleanup 中调用：

- Activity 隐藏或页面卸载会 abort 两条链的本地等待；不会调用服务端停止接口，也不撤销已发生的探测/`adb connect`。
- section 切换不触发取消：设备面板会随 connection section 卸载/挂载，但在途请求继续，结果写入模块级 owner，恢复 connection 后显示。
- 已完成的结果保存在模块级 owner 中，恢复后继续展示；不自动重发，用户可再次查找或测试。
- hook 恢复时重新订阅；真正卸载后 owner 仍是同一实例，未完成请求已被取消，不会在后台回填页面。

## 3. 版本与配置目录

### 3.1 Query 身份与归一化

```ts
settingsKeys.query('version')          // ['settings', 'version']
settingsKeys.query('config-directory') // ['settings', 'config-directory']
```

- `versionQueryOptions()` 把 Query 的 `AbortSignal` 传给 `getVersion(signal)`，只接受 `cli`/`core`/`raw` 为字符串；坏的 `resource` 块被归一为 `unknown` 状态与空字段，缺失 `resource` 时页面不显示资源行。不可用载荷成为 `contract` 失败。
- `configDirectoryQueryOptions()` 把 signal 传给 `getConfigDir(signal)`，同时接受服务端当前的 `{ path }` 与旧的纯字符串形状；空白路径视为 `contract` 失败。`getConfigDir` 的返回类型因此从 `ApiResponse<string>` 修正为 `ApiResponse<string | { path: string }>`，与运行时的旧字符串/对象两种形状一致。
- 两者沿用 Query 默认策略：30s 新鲜期、可恢复失败最多重试 2 次、`contract` 失败与取消不重试。传输失败时初始目录错误最多延后约 1.5s 出现，与 FPR-024 的 connection 读取一致。

### 3.2 页面语义

- 版本读取失败保持静默（迁移前行为）；页面继续渲染其余内容。更新成功后的版本同步由 FPR-026 的更新命令调用 `useSettingsVersion().reload()`，其内部 `invalidateQueries` 同一 `settings/version`：页面可见时立即重取，隐藏时恢复显示后重取，见[设置组件更新与自动更新](settings-updates-and-auto-update.md)。
- 配置目录首次读取中显示“正在读取目录...”；从未成功读取且失败时显示 `配置目录读取失败: <原因>` 与“重试”按钮，重试走 `refetchQueries` 同一 key。
- 后台刷新失败保留最近一次成功路径；只有从未成功读取过才显示错误，避免 Activity 恢复后的后台失败清空可用路径。
- 打开目录有两个原有入口：只读 section 的卡片头按钮与配置目录卡片按钮。两者都调用 `useSettingsConfigDirectory().open()`；成功提示“已打开配置目录”，失败提示 `打开失败: <原因>`，不触发 Query 重取。
- section 切换不取消在途设备命令，也不清空设备列表、测试反馈、版本与目录路径；设备面板随 connection section 卸载/挂载，但状态保存在模块级 owner 与 Query 缓存中。设备命令的取消只由 Activity 隐藏或页面真正卸载触发（`SettingsWorkspace` 的 `useDeviceConnectionActivityCleanup`），不是面板可见性。
- 配置目录的只读 section 头部观察者只复用缓存：`useSettingsConfigDirectory({ cacheOnly: true })` 显式关闭 `refetchOnMount` 与 `retryOnMount`，切 section 不产生新请求，失败后也不自动重试；目录卡片的观察者保持默认策略，加载与重试入口仍只在那里。

## 4. 面板接线与遗留清理

`ConfigManager` 只组合 `SettingsWorkspace`；设备发现、连接测试、版本、配置目录与打开目录由 FPR-025 的 hooks 持有，FPR-034 后分别由设备、更新与目录面板订阅。`ConfigManager` 与各面板都不直接导入 `discoverDevices`、`testConnection`、`getVersion`、`getConfigDir`、`openConfigDir`，也不保存设备列表、查找/测试 loading、测试反馈、版本、目录路径/状态/错误的页面 state。对这些资源，面板只保留渲染与全局状态提示；组件更新与自动更新由 FPR-026 的模块级所有者持有，见[设置组件更新与自动更新](settings-updates-and-auto-update.md)。

| 页面原职责 | 新归属 |
| --- | --- |
| `handleDiscoverDevices` / `handleTestConnection` / `handleUseDiscoveredDevice` | `DeviceConnectionPanel` → `useSettingsDeviceConnection()` 动作 |
| 设备列表、查找提示、`hasSearchedDevices`、`discoveringDevices` | `DeviceConnectionOwner.discovery` |
| 测试 loading 与 `connectionFeedback` | `DeviceConnectionOwner.test` |
| `loadVersion` 与 `versionInfo` state | `SettingsUpdatesPanel` → `useSettingsVersion()` + `settings/version` |
| `loadConfigDir`、目录三态与重试 | `ConfigDirectoryPanel` / `ReadOnlyConfigPanel` → `useSettingsConfigDirectory()` + `settings/config-directory` |
| `handleOpenConfigDir` 的 API/错误分支 | `useSettingsConfigDirectory().open()`；目录卡片与只读 section 头部共享同一命令 |

自动更新与 core/cli/资源更新已由 FPR-026 迁移到 `model/autoUpdateConfig.ts`、`model/updateCommands.ts` 及其 hooks，见[设置组件更新与自动更新](settings-updates-and-auto-update.md)；本任务只把更新成功后的版本读取接到同一 Query。

## 5. 兼容与回滚

- 端点、请求体与响应体未改变；未修改服务端。设备发现仍是 GET、连接测试与打开目录仍是 POST。
- 新增 Query key 只存在于内存，浏览器刷新随缓存丢失；没有新增 localStorage 数据。
- 默认渲染结构、DOM、CSS 与文案未改变；失败/取消状态仍走原有提示区域，视觉基线不因本任务更新。
- 行为差异：
  - 设备发现与连接测试请求现在在 Activity 隐藏/卸载时 abort；迁移前会继续完成并写页面 state。section 切换不取消命令（与迁移前一致），但设备面板会卸载并在恢复 connection 后从 owner 读取结果。
  - 非数组/坏设备条目被跳过而不是抛错；未知状态/来源回退为“状态未知”/ADB。
  - 配置目录后台刷新失败保留最近成功路径；迁移前显式重读失败会清空路径。
  - 版本 `resource` 块按已知字段归一；坏字段显示 `unknown`，不再把任意对象直接传入渲染。
  - 传输失败按 Query 默认重试，错误提示最多延后约 1.5s。
- 独立回滚范围：`model/deviceConnection.ts`、`hooks/useSettingsDeviceConnection.ts`、`model/systemResources.ts`、`hooks/useSettingsVersion.ts`、`hooks/useSettingsConfigDirectory.ts`、`api/index.ts` 的目录返回类型与 `DeviceConnectionPanel`/`ConfigDirectoryPanel`/`ReadOnlyConfigPanel`/`SettingsUpdatesPanel` 的接线。回滚后恢复页面 state 与原直连调用，不需要数据迁移。

## 6. 回归证据

| 测试 | 覆盖 |
| --- | --- |
| `features/settings/model/deviceConnection.test.ts` | 两条链初始/运行态、loading 互不影响、设备归一与坏条目、内层/信封/传输失败、取消与迟到响应、新请求取代旧请求、测试成功/未连接/请求失败、草稿 revision 与 `superseded`、选择回填保留未知字段与最新编辑、`cancelAll` 与 reset |
| `features/settings/model/systemResources.test.ts` | `version`/`config-directory` key、signal、版本与目录归一化、旧字符串目录、空白路径与坏载荷 contract 失败、信封失败 |
| `features/settings/pages/ConfigManager.layout.test.tsx` | 发现使用草稿 adb 路径并回填选中设备、查找/测试 loading 独立、查找失败重试与连接测试失败反馈、Activity 隐藏取消在途查找/测试并保留已完成结果、section 切换不取消在途查找、测试期间编辑不被覆盖、版本/目录 Query 在 hide/show 后复用、两个打开目录入口、目录失败后切只读 section 不重试且保留重试入口、更新成功后失效并重取同一版本 Query（FPR-026）、目录失败重试 |
| `features/settings/pages/ConfigManager.subscriptions.test.tsx` | 设备状态不重渲染连接/目录面板；目录缓存变化不重渲染连接/更新面板；连接草稿编辑不重渲染更新/目录面板 |
| `features/settings/components/ReadOnlyConfigPanel.test.tsx` | 只读头部复用过期目录缓存、不触发目录读取；打开目录在目录可用时可点 |

面板组合与完整回归清单见[设置领域面板](settings-panel.md)。

复现命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client exec vitest run src/features/settings
```

完整 `pnpm --filter la-pluma-next-client verify` 与视觉比对由任务完成记录给出。

## 关联

- [设置配置编辑与保存](settings-config-editing.md)：connection 草稿、保存与 section 状态。
- [设置组件更新与自动更新](settings-updates-and-auto-update.md)：版本失效、更新命令与自动更新策略。
- [Query 缓存与键规范](query-cache.md)：`settings/version`、`settings/config-directory` 的缓存身份与 Activity 策略。
- [资源请求错误与取消契约](resource-requests.md)：signal、失败分类与载荷校验。
- [前端职责与质量基线](frontend-baseline.md)：Settings 页职责矩阵与 Activity 生命期。
