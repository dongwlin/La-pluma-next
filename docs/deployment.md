# 部署指南

> [← 返回 README](../README.md)

本地开发安装见根目录 README 的“快速开始”。

## Docker 部署

> ✨ **推荐方式**：使用 GHCR 预构建镜像，开箱即用！

### 使用 GHCR 镜像（推荐）

```bash
# 拉取最新镜像
docker pull ghcr.io/dongwlin/la-pluma-next:latest

# 运行容器
docker run -d \
  --name la-pluma-next \
  -p 3055:3000 \
  -v /path/to/data:/app/server/data \
  -v /path/to/config:/root/.config/maa \
  -v /path/to/maacore:/root/.local/share/maa \
  -e ADB_ADDRESS=192.168.x.x:5555 \
  ghcr.io/dongwlin/la-pluma-next:latest

# 如需开启 API 鉴权，把下面一行插入到镜像名前：
#   -e LA_PLUMA_TOKEN=change-me \

# 访问应用
# 浏览器打开 http://localhost:3055
```

> 首次发布后请在 GitHub Package settings 中把 `la-pluma-next` 镜像设为 Public；如果保持私有，拉取前需要先执行 `docker login ghcr.io`。

可选环境变量：

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `PORT` | 后端监听端口 | `3000` |
| `LA_PLUMA_BASE_PATH` | 生产环境前端挂载路径，需与构建时 `VITE_BASE_PATH` 一致 | `/` |
| `ADB_PATH` | ADB 可执行文件路径 | `/opt/homebrew/bin/adb` |
| `ADB_ADDRESS` | 默认 ADB 设备地址 | `127.0.0.1:16384` |
| `MAA_CLI_PATH` | `maa` CLI 可执行文件路径 | 本地为 `maa`，Docker 为 `/usr/local/bin/maa` |
| `MAA_CLIENT_TYPE` | 默认客户端类型 | `Official` |
| `LA_PLUMA_TOKEN` | 设置后 `/api/*` 与 WebRTC 票据入口需要 Bearer Token 或 `X-La-Pluma-Token` | 空，不启用 |
| `LA_PLUMA_AGENT_RUN_STORE` | Agent Run 与幂等记录的持久化文件 | `server/data/agent-runs.json` |
| `LA_PLUMA_MAX_REALTIME_LOGS` | 实时日志内存缓存最大行数 | `5000` |
| `LA_PLUMA_WEBRTC_DIR` | ScrcpyOverWebRTC 工作目录 | `$HOME/ScrcpyOverWebRTC` |
| `LA_PLUMA_WEBRTC_PORT` | ScrcpyOverWebRTC 本地端口 | `8443` |
| `LA_PLUMA_WEBRTC_HOST_IP` | 向设备公布的宿主机 IPv4 地址；默认优先选择与目标 ADB 地址同网段的网卡 | 自动检测 |
| `LA_PLUMA_WEBRTC_ICE_SERVERS` | 自定义 STUN/TURN 列表；未设置且无本地 TURN 时使用局域网直连 | 自动检测 |
| `LA_PLUMA_WEBRTC_ARCHIVE` | 安装时使用的本地官方 `cloudphone-v0.4.1.zip`，同样校验 SHA-256 | 自动下载 |
| `LA_PLUMA_HTTPS_CERT_PATH` | 可选 HTTPS 证书链路径，必须与私钥同时配置 | 空，使用 HTTP |
| `LA_PLUMA_HTTPS_KEY_PATH` | 可选 HTTPS 私钥路径，必须与证书同时配置 | 空，使用 HTTP |

### PWA、HTTPS 与实时预览

PWA 的 Service Worker 只会在 HTTPS 或浏览器认可的本机 `localhost` 安全上下文中启用。生产构建在电脑本机通过 `http://localhost:*` 打开时可以安装；手机通过 `http://192.168.x.x:*` 访问时不能安装，也不会获得离线界面缓存。Vite 开发模式默认不注册 Service Worker。

不要把 `5173` 的 Vite 开发服务器作为手机主屏幕或公网长期入口。开发服务器的 HMR 连接在 iOS 后台挂起后可能触发整页重载；手机入口应使用 `pnpm --filter la-pluma-next-client build` 生成的正式资源，并由下方的生产服务或可信 HTTPS 反向代理提供。

La Pluma Next 可以直接使用可信证书启动 HTTPS：

```bash
pnpm --filter la-pluma-next-client build

NODE_ENV=production \
LA_PLUMA_HTTPS_CERT_PATH=/path/to/fullchain.pem \
LA_PLUMA_HTTPS_KEY_PATH=/path/to/privkey.pem \
pnpm start
```

Docker 部署时把证书只读挂载到容器，并同时设置这两个变量：

```bash
docker run -d \
  --name la-pluma-next \
  -p 3055:3000 \
  -v /path/to/certs:/app/certs:ro \
  -v /path/to/data:/app/server/data \
  -e LA_PLUMA_HTTPS_CERT_PATH=/app/certs/fullchain.pem \
  -e LA_PLUMA_HTTPS_KEY_PATH=/app/certs/privkey.pem \
  -e LA_PLUMA_TOKEN=change-me \
  ghcr.io/dongwlin/la-pluma-next:latest
```

证书必须受访问设备信任，并覆盖实际使用的域名或 IP。仅在浏览器中临时忽略自签名证书警告，不能可靠满足 PWA 安装要求。网络访问建议始终配置 `LA_PLUMA_TOKEN`。

HTTPS 下的实时预览使用同源 `/webrtc-signaling` 网关并自动升级为 WSS，不再让浏览器直连不安全的 `ws://`。如果由 Caddy、Nginx 或 NAS 反向代理终止 TLS，需要把 `/api`、`/health` 和 `/webrtc-signaling` 一并转发到 La Pluma Next，并允许 `/webrtc-signaling` 的 WebSocket Upgrade。

PWA 缓存范围仅包含界面资源。断网时可以打开已缓存页面，但 MAA、ADB、实时预览、状态读取和所有自动化操作仍需要连接 La Pluma Next 后端；页面会持续显示断连状态并禁用控制台执行入口。

### 子路径部署

部署到 `/la-pluma-next/` 等子路径时，需要在构建前设置：

```bash
VITE_BASE_PATH=/la-pluma-next/ pnpm --filter la-pluma-next-client build

NODE_ENV=production \
LA_PLUMA_BASE_PATH=/la-pluma-next/ \
pnpm start

# Docker 本地构建
docker build --build-arg VITE_BASE_PATH=/la-pluma-next/ -t la-pluma-next:local .
```

本地运行时要让 `LA_PLUMA_BASE_PATH` 与构建时的 `VITE_BASE_PATH` 保持一致；通过 Docker build arg 构建时，镜像会自动写入对应的运行时挂载路径。反向代理应保留 `/la-pluma-next/` 前缀转发，同时继续同源转发根路径 `/api`、`/health` 与 `/webrtc-signaling`。路径建议以前导和结尾 `/` 表示，构建与服务端都会自动规范常见写法。

### 使用 Docker Compose（推荐）

```bash
# 1. 克隆仓库
git clone https://github.com/dongwlin/La-pluma-next.git
cd La-pluma-next

# 2. 编辑 docker-compose.yml，修改 volumes 和 ADB_ADDRESS
nano docker-compose.yml

# 3. 启动服务（会自动拉取镜像）
docker-compose up -d

# 4. 查看日志
docker-compose logs -f
```

### 本地构建镜像

如果需要修改代码后构建：

```bash
# 编辑 docker-compose.yml
# 注释掉: image: ghcr.io/dongwlin/la-pluma-next:latest
# 取消注释: build 部分

# 构建并启动
docker-compose up -d --build
```

**配置说明**：
- 宿主机端口：`3055`，容器内端口：`3000`
- 数据持久化：`./docker-data/server/`、`./docker-data/maa-config/`、`./docker-data/maa-core/`
- ADB 连接：在 WebUI 中配置设备地址（如 `127.0.0.1:5555`）
- 首次启动会自动下载 MaaCore（约 5-10 分钟）

**支持架构**：
- `linux/amd64` - x86_64 服务器、PC
- `linux/arm64` - ARM64 服务器、Apple Silicon
