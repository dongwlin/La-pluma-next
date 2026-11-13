# 配置与跨平台支持

> [← 返回文档索引](../README.md)

## 运行平台

La Pluma Next 支持 macOS、Linux 和 Windows 系统。服务器按操作系统解析外部 MAA 的目录，路径解析锚定服务端安装位置，与启动时的工作目录无关。与 maa-cli 一致，`MAA_CONFIG_DIR`、`MAA_DATA_DIR`、`MAA_STATE_DIR` 优先于下表的平台默认值，空值按未设置处理；资源目录缺省为数据目录下的 `resource/`，显式设置 `MAA_RESOURCE_DIR` 可整体替换。

服务端读取 MAA 游戏资源（干员目录、养成材料表、物品图标与头像、作业关卡目录）时跟随 MaaCore 的资源覆盖顺序：候选为 MaaCore 附带资源与 `cli.toml` 资源源定位的基础资源（Git 源 checkout 或 MirrorChyan 快照），按文件取更新层中的生效版本，更新层缺文件时回落基础资源；资源同步成功后立即生效。显式设置 `MAA_RESOURCE_DIR` 时独占使用该目录，不再叠加候选层。

| MAA 目录 | macOS | Linux（XDG 标准） | Windows |
| --- | --- | --- | --- |
| 配置 | `~/Library/Application Support/com.loong.maa/` | `$XDG_CONFIG_HOME/maa/`，缺省 `~/.config/maa/` | `%APPDATA%\maa\`，缺省 `~/AppData/Roaming/maa/` |
| 数据 | 同配置目录 | `$XDG_DATA_HOME/maa/`，缺省 `~/.local/share/maa/` | `%LOCALAPPDATA%\maa\`，缺省 `~/AppData/Local/maa/` |
| 状态 | 同配置目录 | `$XDG_STATE_HOME/maa/`，缺省 `~/.local/state/maa/` | 同 Windows 数据目录 |

服务器启动时会自动显示当前系统的路径配置。应用自身的运行数据（Run 存储、用户配置、掉落记录等）默认写入 `apps/server/data/`，可通过部署指南中列出的 `LA_PLUMA_*` 变量重定向；生产环境前端静态资源默认读取 `apps/web/dist/`。

物品图标与干员头像按上一段的资源覆盖顺序读取各候选资源层的 `template/items/`（文件按物品 id 命名）与 `template/avatar/`（按干员 id 命名的**基础头像**）；MAA 标准资源不提供 `_1`/`_2` 变体头像，需要变体时把 `LA_PLUMA_GAME_ASSET_DIR` 指向含 `item/`、`avatar/` 子目录的自定义目录（此时独占生效，不再叠加候选层），变体文件按 `<干员 id>_1.png`、`<干员 id>_2.png` 命名。请求键与文件名不一致时（例如仍是 item_table 的 iconId），服务端会借助本地 `item_table.json` 自动解析，`item_table.json` 缺失时回退到 `item_index.json` 的 `icon` 字段。

养成相关数据（队列、材料表、干员材料、仓库/干员识别结果）使用 `LA_PLUMA_TRAINING_DATA_DIR`，默认同为 `apps/server/data/`。材料与掉落抓取脚本复用同一目录解析，重定向后脚本与服务读写同一位置。

## 应用配置

### 配置能力范围

设置页只暴露当前 maa-cli（0.7.x）与 MaaCore 实际支持的字段；不支持或不属本页职责的配置保持文件级维护：

| 配置 | 设置页支持 | 说明 |
| --- | --- | --- |
| `[connection].preset` | 是 | `ADB` / `MuMuPro` / `PlayCover` / `Waydroid` / `Androws` |
| `[connection].adb_path` / `address` / `config` | 是 | 显式值优先于预设默认值 |
| `[connection].type` / `device` 旧别名 | 是（自动迁移） | 读取与保存都迁移为 `preset` / `address`；正名缺失时旧键值补位，两键并存时正名优先，保存后不再写回旧键 |
| `[behavior].auto_reconnect` | 是 | 旧版写在 `[connection]` 的值只在 `[behavior]` 缺失时兼容读取 |
| `[instance_options]` 四项 | 是 | `touch_mode`、`deployment_with_pause`、`adb_lite_enabled`、`kill_adb_on_exit` |
| `[instance_options]` 未知字段 | 保留 | 不展示，保存时不覆盖 |
| `[static_options].cpu_ocr` / `gpu_ocr` | 否 | 不进本页表单 |
| profile `[resource]`（`global_resource` 等） | 否 | 属于资源加载覆盖，不是资源来源 |
| cli.toml `[resource].auto_update` / `warn_on_update_failure` / `[resource.source]` | 是 | Git 固定使用官方 HTTPS 仓库，MirrorChyan 独立配置。更新前检查和人工纠正位置见 [资源更新集成](../server/integrations.md#maa-cli-子进程与实时日志) |
| cli.toml `[core]` / `[cli]` 更新渠道 | 是（组件更新卡片） | 由更新渠道表单维护 |
| cli.toml `[hot_update]` | 否 | 任务缓存热更新，属另一功能 |
| cli.toml `github_proxy` | 否 | 不进本页表单 |

### ADB 连接配置

在「配置 → 连接」页面配置 ADB 连接，保存后写入 maa-cli 的 profile（`maa dir config` 解析出的 `profiles/<profile>.toml`）：

- **连接预设**：`ADB`、`MuMuPro`、`PlayCover`、`Waydroid`、`Androws`，对应 `[connection].preset`，提供各环境的默认 ADB 路径与平台配置；显式填写的字段优先
- **ADB 路径**：按平台默认 macOS `/opt/homebrew/bin/adb`、Linux `/usr/bin/adb`、Windows `adb.exe`；Docker 镜像为 `/usr/bin/adb`，也可用 `ADB_PATH` 覆盖
- **设备地址**：
  - 本地模拟器：`emulator-5554` 或 `127.0.0.1:5555`
  - 远程设备：`192.168.x.x:16384`（需要开启网络 ADB）
- **平台配置**：写入 `[connection].config`（`CompatMac`/`CompatPOSIXShell`/`General`）
- **自动重连**：写入 `[behavior].auto_reconnect`

「配置 → 实例」写入同一 profile 的 `[instance_options]`：触控模式（`Adb`/`MiniTouch`/`MaaTouch`/`MacPlayTools`/`MaaFwAdb`）、部署时暂停、ADB Lite 与退出时结束 ADB。缺失字段按 MaaCore 默认值显示，保存时只覆盖表单涉及的字段，profile 中其它未知 section 原样保留。

### 日常任务与资源更新

理智作战、基建、公招等本地任务使用已安装资源及已有热更新缓存。每次执行会创建独立的临时缓存，任务退出后清理，避免 maa-cli 启动时的热更新请求因网络故障而阻断日常流程；原缓存和连接配置保持不变。

「同步资源」通过 `maa hot-update` 执行。「配置 → 资源」可选 Git 或 MirrorChyan，并设置自动更新与失败告警。Git 使用官方 HTTPS 仓库，表单提供后端选择。MirrorChyan 表单提供 CDK 与检查间隔，CDK 输入框留空会保留已保存的值。资源同步的配置核验见 [MAA CLI 集成](../server/integrations.md#maa-cli-子进程与实时日志)。

远程作业下载和活动查询使用原缓存及联网流程。若在 maa-cli 中显式禁用热更新缓存（`hot_update.check_interval = 0`）或启用资源自动更新（`resource.auto_update = true`），任务仍会遵循这些联网设置。

### Telegram 通知配置

在"通知设置"页面配置：

1. 创建 Telegram Bot（通过 @BotFather）
2. 获取 Bot Token
3. 获取 Chat ID（通过 @userinfobot）
4. 填入配置并测试

**Bot 远程控制**：配置完成后，Bot 会自动启动，支持以下命令：

```
/help - 显示帮助信息
/status - 查看当前任务状态
/fight <关卡> - 执行理智作战（例如：/fight 1-7）
/roguelike [主题] - 执行肉鸽任务（例如：/roguelike Sami）
/stop - 停止当前任务
```

**注意**：Bot 只响应配置的 Chat ID，其他用户无法控制。
