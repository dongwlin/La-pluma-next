# 设置配置编辑与保存

> [← 返回文档索引](README.md)

本文描述 FPR-024 交付的设置页配置编辑模型：MAA profile 的 `connection` 段如何读取、编辑、保存与重置，以及 `connection`/`resource`/`instance` 三个 section 的状态、存储键与 window 事件的归属。配置读取走 `settings/maa-config` Query，草稿与保存由 `features/settings/model/connectionConfig.ts` 的模块级所有者持有。

设备发现、连接测试、版本、配置目录与打开目录由 FPR-025 接管，见[设置设备连接与系统资源](settings-device-and-resources.md)；组件更新与自动更新流程仍由 FPR-026 接手。自动更新的**归一化模型**已在本次移入 `model/configNormalization.ts`，其草稿、提交与调度状态机仍留在页面。

验证入口见文末[回归证据](#6-回归证据)。

## 1. 定位与边界

| section | 可编辑 | 服务端资源 | 保存 / 重置 |
| --- | --- | --- | --- |
| `connection` | 是 | `settings/maa-config` Query + `ConnectionConfigOwner` 草稿 | 显式保存；重置只改草稿 |
| `resource` | 否 | 配置目录等只读说明（读取归 FPR-025，见[设置设备连接与系统资源](settings-device-and-resources.md)） | 不渲染保存/重置 |
| `instance` | 否 | MAA 管理的实例选项 | 不渲染保存/重置 |

归属：

| 能力 | 所有者 | 不负责 |
| --- | --- | --- |
| 服务端只读快照、取消与重试 | `settings/maa-config` Query（`model/connectionConfig.ts`） | 草稿合并、保存时机 |
| 草稿、revision、迟到读取裁决、保存去重与结果 | `ConnectionConfigOwner` | 服务端事务、跨客户端条件写 |
| section 选择、存储键、window 事件与清理 | `model/configSection.ts` + `hooks/useConfigSection.ts` | 配置读取或保存 |
| 页面反馈、保存按钮 loading、section 面板组合 | `pages/ConfigManager.tsx` | 再维护一份 revision 或草稿副本 |

`resource` 与 `instance` 没有可写入口；切到只读 section 不影响 connection 草稿，也不触发服务端读取。`connection` 的保存进行中切换到其它 section 时保存继续执行，返回后草稿与反馈仍然有效。

## 2. 读取与草稿

### 2.1 Query 身份与载荷

```ts
settingsKeys.query('maa-config', profileName) // ['settings', 'maa-config', profileName]
```

- Query 只保存服务端只读快照，不直接写页面；`queryFn` 把 Query 的 `AbortSignal` 传给 `getConfig(profileName, signal)`，Activity 隐藏或卸载时由 Query 取消观察并按既有策略保留缓存。
- `getConfig` 收紧载荷校验：`adb_path`、`address`、`config` 出现时必须是字符串，`auto_reconnect` 出现时必须是布尔；已知字段类型不合法返回 `INVALID_DOMAIN_PAYLOAD`。缺失字段是合法的 MAA profile 形态，由归一化模型补页面默认值。
- 归一化保留 `connection` 段中的未知字段，保存时随快照原样回写；已知字段缺失或类型不合法时使用页面原有默认值（`/opt/homebrew/bin/adb`、`127.0.0.1:16384`、`CompatMac`、自动重连开启）。
- Query 默认策略沿用 [Query 缓存与键规范](query-cache.md)：30s 新鲜期、可恢复失败最多重试 2 次、`contract` 失败与取消不重试。

### 2.2 草稿状态

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

### 2.3 迟到读取与 refresh

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

### 2.4 保存

保存是显式动作，wire 不变：`POST /agent/config/maa/:profileName`，请求体 `{ connection: snapshot }`。

- 同一时刻只允许一次保存；保存中再次调用返回 `ignored`，页面不重复提示。
- 保存期间仍可编辑。响应返回时只有 revision 未变才把当前草稿视为已保存；否则返回 `superseded`，页面提示“此前连接配置已保存，当前更改尚未保存”，并保留新草稿。
- 保存成功清除 dirty、更新 `persisted` 与 `lastSavedAt`，并推进 revision 使保存前的读取失效；保存失败保留草稿与 `failed`/`error`，下一次保存重试同一份最新草稿。
- 服务端只返回成功信封，不回写 profile；页面按已发送快照确认，不伪造服务端归一化结果。

### 2.5 重置

“重置”只把草稿恢复为页面原有默认值：

- 不调用保存端点；用户下一次显式“保存”才写入服务端；
- 保存进行中时忽略重置；
- 重置推进 revision，使重置前发出的读取不能把服务端旧值带回；
- 重置会丢弃从服务端读取到的未知 connection 字段（恢复的是完整默认快照），与迁移前的重置行为一致。

### 2.6 读取失败

初始读取失败（尚无 Query 数据）沿用迁移前的页内 `role="alert"` 与全局状态消息：`连接配置读取失败: <原因>`。已有服务端数据后的后台 refresh 失败不打断编辑，也不重复写全局消息。读取成功后清除对应的初始失败提示。

## 3. Section 状态与清理

| 项目 | 值 / 行为 |
| --- | --- |
| 存储键 | `laPlumaConfigSection`（兼容键，不改名） |
| window 事件 | `la-pluma-config-section`，`detail` 为 `connection`/`resource`/`instance` |
| 初始值 | 读取存储；缺失或非法值回退 `connection` |
| 点击 section | 写存储并更新页面状态 |
| 外部事件 | 校验 `detail`，写存储并更新页面状态；非法 detail 忽略 |
| 清理 | `useConfigSection` 在 Effect cleanup 中注销 window 监听；Activity 隐藏/恢复与真正卸载都会清理并重新订阅 |

`model/configSection.ts` 是这些常量的唯一所有者；`useConfigSection.ts` 只负责 React 订阅。页面不再自己读 `localStorage`、注册 `la-pluma-config-section` 监听或持有 `setConfigType`。

section 只控制渲染哪个面板：connection 的 Query 在 section 分支之前订阅，切 section 不卸载 Query、不重读服务端、不清空草稿。`resource`/`instance` 的能力由 `isEditableConfigSection()` 明确为只读，保存/重置按钮只在 connection 渲染。

## 4. 页面接线

- `useSettingsConnectionConfig()` 返回 `draft`、`dirty`、`syncState`、`error`、`loaded`、`loadError`、`update`、`restoreDefaults`、`save`、`reload`；页面只渲染表单、按钮 loading 与反馈。
- 页面删除的职责：`configData` state、`loadConfig()`、`connectionRevisionRef`、`connectionSaveInFlightRef`、section `localStorage` 读写与 window 监听。
- 输入、平台配置与自动重连开关都通过 `update(patch)` 写入 owner；编辑清空页内反馈与保存错误。
- 保存按钮 loading 取 `syncState === 'saving'`，重置按钮在保存中禁用；保存结果按 `saved`/`superseded`/`failed` 分别提示。
- 自动更新仍保持迁移前逻辑：读取/本地回退、touched/revision、保存后 `setupAutoUpdate`；只把 `DEFAULT_AUTO_UPDATE_CONFIG`、`normalizeAutoUpdateConfig` 与 `isValidUpdateTime` 从页面移入 `model/configNormalization.ts`，供 FPR-026 复用。
- 设备发现、连接测试、版本、配置目录与打开目录已由 FPR-025 移出页面，见[设置设备连接与系统资源](settings-device-and-resources.md)；组件更新与自动更新仍由 FPR-026 继续迁移。

## 5. 兼容与回滚

- 端点、请求体、响应体与服务端 TOML 写入方式未改变；配置 key、profile 名与 section 存储键/事件名保持不变。
- 新增 Query key `['settings','maa-config',profileName]` 只存在于内存，浏览器刷新随缓存丢失；没有新增 localStorage 数据。
- 载荷校验比迁移前严格：已知字段类型不合法时整份读取失败并显示错误，而旧页面会把异常值放入受控输入。未知 connection 字段仍原样保留。
- 已知字段缺失时显示页面默认值，而旧页面会显示空输入；这是归一化模型的要求，正常服务端载荷（`getConfig` 自带默认值）不受影响。
- 默认渲染结构、DOM 与 CSS 未改变；失败/`superseded` 提示只在非默认状态出现，视觉基线不因本任务更新。
- 独立回滚范围：`features/settings/model/configNormalization.ts`、`model/connectionConfig.ts`、`model/queryKeys.ts`、`model/configSection.ts`、`hooks/useConfigSection.ts`、`hooks/useSettingsConnectionConfig.ts` 与 `ConfigManager` 的 connection/section 接线，以及 API 校验收紧；回滚后恢复页面本地 state，不需要数据迁移。

## 6. 回归证据

| 测试 | 覆盖 |
| --- | --- |
| `features/settings/model/configNormalization.test.ts` | connection 默认值与非法字段回退、未知字段保留、整份草稿比较；auto-update 归一化与 `HH:MM` 校验 |
| `features/settings/model/connectionConfig.test.ts` | 初始状态、编辑 revision/dirty、服务端采用条件、编辑期间迟到读取、脏草稿读取、保存前读取失效、保存在途读取、保存串行、保存期间编辑、失败保留与重试、未知字段回写、重置边界与保存中忽略、`settings/maa-config` key/signal/contract 失败/信封失败 |
| `features/settings/model/configSection.test.ts` | 存储键与事件名、非法存储回退、写入不抛错、可编辑能力、合法事件过滤与注销 |
| `features/settings/api/index.test.ts` | `getConfig` signal、profile 载荷校验、非法已知字段拒绝与未知字段保留 |
| `features/settings/pages/ConfigManager.layout.test.tsx` | section 导航与只读说明、初始读取失败、初始加载/refresh 不覆盖编辑、保存期间继续编辑与跨 section 保存、重置只改草稿、外部 section 事件/存储/监听清理、Activity 恢复保留草稿并重新订阅、自动更新保存边界、连接保存失败 |

复现命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client verify
```

## 关联

- [设置设备连接与系统资源](settings-device-and-resources.md)：设备发现/连接测试、版本与配置目录。
- [Query 缓存与键规范](query-cache.md)：`settings/maa-config` 的缓存身份、默认重试与 Activity 行为。
- [前端职责与质量基线](frontend-baseline.md)：Settings 页职责矩阵与剩余迁移项。
- [资源请求错误与取消契约](resource-requests.md)：`getConfig` 的 signal 与载荷校验。
- [配置同步与资源一致性契约](config-sync-and-invalidation.md)：配置草稿、迟到加载与跨页失效的通用不变量。
