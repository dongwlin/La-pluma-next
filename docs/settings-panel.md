# 设置领域面板

> [← 返回文档索引](README.md)

本文说明设置页面组合与面板订阅边界。连接草稿、设备命令、版本/目录读取、组件更新与自动更新的所有者、Query key、wire 与失效语义均未改变；页面/面板分别承担组合与订阅职责，不新增缓存、命令状态或存储。

相关契约：[设置配置编辑与保存](settings-config-editing.md)、[设置设备连接与系统资源](settings-device-and-resources.md)、[设置组件更新与自动更新](settings-updates-and-auto-update.md)、[Query 缓存与键规范](query-cache.md)、[前端架构与所有权](frontend-architecture.md)。

## 1. 定位与边界

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

## 2. 组合与订阅边界

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

## 3. Section 与草稿生命期

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

## 4. 设备命令的取消边界

设备命令的取消仍属于页面/Activity 生命周期，而不是面板可见性：

- `useSettingsDeviceConnection()` 只订阅 owner 并转发动作，不再在自身 Effect cleanup 中取消命令。
- `SettingsWorkspace` 调用 `useDeviceConnectionActivityCleanup()`，在 Activity 隐藏或页面真正卸载时执行 `cancelAll()`。
- 因此切换到只读 section 不会中断在途查找/测试；设备面板重新显示时读取 owner 的最新结果，不自动重发。
- 地址输入变更仍只清除旧测试反馈，不取消在途测试。

## 5. 错误反馈的归属

| 反馈 | 渲染位置 | 来源 |
| --- | --- | --- |
| 连接读取/保存失败、`superseded` 警告 | `.config-editor-card` 内 | `ConnectionConfigPanel` 本地反馈 + owner 结果 |
| 设备查找/连接测试失败 | 设备分组内 | `DeviceConnectionOwner.discovery/test` |
| 目录读取失败与重试 | 目录卡片内 | `config-directory` Query 状态 |
| 自动更新读取/保存/调度失败 | 更新卡片自动更新分组 | `AutoUpdateConfigOwner` |
| 组件更新失败与资源重试 | 更新卡片底部 | `SettingsUpdateOwner` |

各面板只渲染自己的反馈；一个用例的失败不会写入另一个面板的页内状态。全局状态消息仍由各面板在明确结果后调用 `useStatusStore`。

## 6. 兼容与维护约束

- Query key、读取时机、失效作用域、失败保旧、设备命令 wire、更新顺序与自动更新本地键均未变。
- 保持默认 connection 页面、resource 与 instance 只读页面的 DOM、标签关联与视觉约束；section 切换和只读入口由下列回归测试覆盖。
- 唯一可见的生命期差异：section 切换不再卸载设备 hook，而是卸载设备面板；在途命令不取消（与迁移前语义一致），恢复后从 owner 显示结果。

## 7. 回归测试

| 文件 | 覆盖 |
| --- | --- |
| `pages/settings/ConfigManager.layout.test.tsx` | section 导航/存储/事件/清理、草稿读取/保存/重置、保存期间切 section、目录失败重试、设备发现/测试/取消、版本与目录 Query 复用、更新互斥/失效/失败重试、自动更新边界、两个打开目录入口；新增连接与更新反馈互不串面板、跨 section 的在途查找不取消、目录失败后切只读 section 不重试且保留重试入口、只读首屏共享一次目录读取 |
| `pages/settings/ConfigManager.subscriptions.test.tsx` | 设备/更新/自动更新状态与全局状态提示不重渲染连接表单；自动更新编辑不重渲染组件更新面板；连接草稿编辑不重渲染更新/版本/目录面板；设备/更新动作不重渲染目录面板；目录缓存变化不重渲染连接/更新面板 |
| `features/settings/components/ReadOnlyConfigPanel.test.tsx` | 只读头部挂载时复用过期目录缓存、不触发 `getConfigDir`；目录可用时“打开目录”保持可点 |
| `features/settings/model/*.test.ts`、`features/settings/api/index.test.ts` | 配置归一/校验、section 模型、connection 草稿、设备命令、版本/目录、更新与自动更新所有者既有回归（当前未改协议） |

视觉基线只覆盖默认 connection 页面，resource/instance 只读态不在截图内。仓库内保留只读文案/入口、目录失败切换与 section 切换的行为回归；完整只读标记结构仍依赖代码审阅。

针对性命令（仓库根目录）：

```sh
pnpm --filter la-pluma-next-client exec vitest run src/features/settings src/pages/settings
```

完整验证与视觉回归入口见[开发指南](development.md)。

## 关联

- [设置配置编辑与保存](settings-config-editing.md)：connection Query、草稿/revision、保存/重置与 section 状态。
- [设置设备连接与系统资源](settings-device-and-resources.md)：设备命令、版本/目录 Query 与取消语义。
- [设置组件更新与自动更新](settings-updates-and-auto-update.md)：更新命令、版本失效与自动更新完整提交。
