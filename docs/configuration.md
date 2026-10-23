# 配置与跨平台支持

> [← 返回 README](../README.md)

## 运行平台

La Pluma Next 支持 macOS 和 Linux 系统。项目会自动检测操作系统并使用对应的配置路径：

### 配置文件路径

- **macOS**: `~/Library/Application Support/com.loong.maa/`
- **Linux**: `~/.config/maa/` (遵循 XDG 标准)

服务器启动时会自动显示当前系统的路径配置。

## 应用配置

### ADB 连接配置

在「日常」页面配置 ADB 连接：

- **ADB 路径**：默认 `/opt/homebrew/bin/adb`
- **设备地址**：
  - 本地模拟器：`emulator-5554` 或 `127.0.0.1:5555`
  - 远程设备：`192.168.x.x:16384`（需要开启网络 ADB）

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
