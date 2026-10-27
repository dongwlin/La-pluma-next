# 配置与跨平台支持

> [← 返回文档索引](../README.md)

## 运行平台

La Pluma Next 支持 macOS、Linux 和 Windows 系统。服务器按操作系统解析外部 MAA 的目录，路径解析锚定服务端安装位置，与启动时的工作目录无关：

| MAA 目录 | macOS | Linux（XDG 标准） | Windows |
| --- | --- | --- | --- |
| 配置 | `~/Library/Application Support/com.loong.maa/` | `$XDG_CONFIG_HOME/maa/`，缺省 `~/.config/maa/` | `%APPDATA%\maa\`，缺省 `~/AppData/Roaming/maa/` |
| 数据 | 同配置目录 | `$XDG_DATA_HOME/maa/`，缺省 `~/.local/share/maa/` | `%LOCALAPPDATA%\maa\`，缺省 `~/AppData/Local/maa/` |
| 状态 | 同配置目录 | `$XDG_STATE_HOME/maa/`，缺省 `~/.local/state/maa/` | 同 Windows 数据目录 |

服务器启动时会自动显示当前系统的路径配置。应用自身的运行数据（Run 存储、用户配置、掉落记录等）默认写入 `server/data/`，可通过部署指南中列出的 `LA_PLUMA_*` 变量重定向；生产环境前端静态资源默认读取 `client/dist/`。

## 应用配置

### ADB 连接配置

在「日常」页面配置 ADB 连接：

- **ADB 路径**：默认 `/opt/homebrew/bin/adb`
- **设备地址**：
  - 本地模拟器：`emulator-5554` 或 `127.0.0.1:5555`
  - 远程设备：`192.168.x.x:16384`（需要开启网络 ADB）

### 日常任务与资源更新

理智作战、基建、公招等本地任务使用已安装资源及已有热更新缓存。每次执行会创建独立的临时缓存，任务退出后清理，避免 maa-cli 启动时的热更新请求因网络故障而阻断日常流程；原缓存和连接配置保持不变。

资源同步仍由「同步资源」或显式更新命令执行。远程作业下载和活动查询使用原缓存及联网流程。若在 maa-cli 中显式禁用热更新缓存（`hot_update.check_interval = 0`）或启用资源自动更新（`resource.auto_update = true`），任务仍会遵循这些联网设置。

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
