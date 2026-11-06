# 配置与跨平台支持

> [← 返回文档索引](../README.md)

## 运行平台

La Pluma Next 支持 macOS、Linux 和 Windows 系统。服务器按操作系统解析外部 MAA 的目录，路径解析锚定服务端安装位置，与启动时的工作目录无关。与 maa-cli 一致，`MAA_CONFIG_DIR`、`MAA_DATA_DIR`、`MAA_STATE_DIR` 优先于下表的平台默认值，空值按未设置处理；资源目录始终为数据目录下的 `resource/`。

| MAA 目录 | macOS | Linux（XDG 标准） | Windows |
| --- | --- | --- | --- |
| 配置 | `~/Library/Application Support/com.loong.maa/` | `$XDG_CONFIG_HOME/maa/`，缺省 `~/.config/maa/` | `%APPDATA%\maa\`，缺省 `~/AppData/Roaming/maa/` |
| 数据 | 同配置目录 | `$XDG_DATA_HOME/maa/`，缺省 `~/.local/share/maa/` | `%LOCALAPPDATA%\maa\`，缺省 `~/AppData/Local/maa/` |
| 状态 | 同配置目录 | `$XDG_STATE_HOME/maa/`，缺省 `~/.local/state/maa/` | 同 Windows 数据目录 |

服务器启动时会自动显示当前系统的路径配置。应用自身的运行数据（Run 存储、用户配置、掉落记录等）默认写入 `server/data/`，可通过部署指南中列出的 `LA_PLUMA_*` 变量重定向；生产环境前端静态资源默认读取 `client/dist/`。

物品图标与干员头像默认读取 MAA 资源目录下的 `template/items/`（文件按物品 id 命名）与 `template/avatar/`（按干员 id 命名的**基础头像**）；MAA 标准资源不提供 `_1`/`_2` 变体头像，需要变体时把 `LA_PLUMA_GAME_ASSET_DIR` 指向含 `item/`、`avatar/` 子目录的自定义目录，变体文件按 `<干员 id>_1.png`、`<干员 id>_2.png` 命名。请求键与文件名不一致时（例如仍是 item_table 的 iconId），服务端会在本地 `item_table.json` 可用时自动解析。

养成相关数据（队列、材料表、干员材料、仓库/干员识别结果）使用 `LA_PLUMA_TRAINING_DATA_DIR`，默认同为 `server/data/`。材料与掉落抓取脚本复用同一目录解析，重定向后脚本与服务读写同一位置。

## 应用配置

### 配置能力范围

设置页只暴露当前 maa-cli（0.7.x）与 MaaCore 实际支持的字段；不支持或不属本页职责的配置保持文件级维护：

| 配置 | 设置页支持 | 说明 |
| --- | --- | --- |
| `[connection].preset` | 是 | `ADB` / `MuMuPro` / `PlayCover` / `Waydroid` / `Androws` |
| `[connection].adb_path` / `address` / `config` | 是 | 显式值优先于预设默认值 |
| `[connection].type` / `device` 别名 | 原样透传保留 | 不做读取归一与保存校验；读取与保存都作为未知字段原样保留 |
| `[behavior].auto_reconnect` | 是 | 旧版写在 `[connection]` 的值只在 `[behavior]` 缺失时兼容读取 |
| `[instance_options]` 四项 | 是 | `touch_mode`、`deployment_with_pause`、`adb_lite_enabled`、`kill_adb_on_exit` |
| `[instance_options]` 未知字段 | 保留 | 不展示，保存时不覆盖 |
| `[static_options].cpu_ocr` / `gpu_ocr` | 否 | 不进本页表单 |
| profile `[resource]`（`global_resource` 等） | 否 | 属于资源加载覆盖，不是资源来源 |
| cli.toml `[resource].auto_update` / `warn_on_update_failure` / `[resource.source]` | 是 | Git 与 MirrorChyan 两种来源；旧版 `backend`/`remote` 保存时迁移 |
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

资源同步由「同步资源」或显式更新命令经 `maa hot-update` 执行，下载源、分支、镜像与凭据都读取 maa-cli 的 `cli.toml`（`[resource.source]` 等），La Pluma 不另行硬编码仓库。「配置 → 资源」可以直接编辑这段配置：来源（Git / MirrorChyan）、Git 仓库地址与分支、SSH 凭据、MirrorChyan CDK 与检查间隔、自动更新与失败告警。凭据只写入本地 `cli.toml`，页面只回显「已保存 / 来自环境变量」等形态，输入框留空表示保留已有值；旧版 `[resource]` 的 `backend`/`remote` 写法在保存时迁移为 `[resource.source]`。远程作业下载和活动查询使用原缓存及联网流程。若在 maa-cli 中显式禁用热更新缓存（`hot_update.check_interval = 0`）或启用资源自动更新（`resource.auto_update = true`），任务仍会遵循这些联网设置。

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
