# 设备预览与信令运行时

> [← 返回文档索引](../README.md)

浏览器实时预览不直连上游 ScrcpyOverWebRTC：连接先经过应用同源的 `/webrtc-signaling` 信令网关，再由网关代理到本机回环上的上游信令服务。权威实现在 `server/src/services/webrtcSignalingGateway.ts`、`webrtcService.ts` 与 `webrtcRuntime.ts`。部署环境变量、上游端口边界与通用鉴权规则见[部署指南](../guides/deployment.md)；预览与 Run 执行的关系见[执行身份与生命周期契约](../architecture/execution-lifecycle.md)；前端会话所有权见[前端架构与所有权](../frontend/README.md)。

## 链路总览

1. 预览启停与状态经 `/api/agent` 下的预览 router 进入（`server/src/routes/agentPreviewRoutes.ts` 只做端点映射，`server/src/controllers/agentPreviewController.ts` 做 HTTP 适配）；服务端经生命周期队列启动信令服务与设备端 Agent，启动响应带同源协议描述 `websocket: /webrtc-signaling/connect_client?token=` 等（`server/src/controllers/agentPreviewController.ts:66-73`）。
2. 浏览器向 `POST /webrtc-signaling/api/login` 换取一次性票据。这是上游管理面唯一经应用端口暴露的部分：信令路径的其余请求一律固定 JSON 404，上游管理界面、`/api` 与 `/devices` 不外露（`server/src/app.ts:103-115`）。
3. 网关持票据换得的上游 token，把只含 `connect_client` 的 WebSocket 升级代理到 `127.0.0.1:$LA_PLUMA_WEBRTC_PORT`（默认 8443）的上游监听（`server/src/services/webrtcSignalingGateway.ts:150-162`、`server/src/services/webrtcService.ts:37`）。
4. 每个升级连接登记一个 viewer 租约，连接关闭或网关关闭时释放（`webrtcSignalingGateway.ts:227-247,299-305`）。

预览与截图只管理预览基础设施，不参与设备自动化执行租约（`docs/architecture/execution-lifecycle.md` 第 6 节）。

网关路径固定挂在同源根路径，不随 `LA_PLUMA_BASE_PATH` 子路径偏移：生产静态资源把信令路径列入保留路径，先于 SPA fallback 处理（`server/src/app.ts:148-166`）。工作目录 `LA_PLUMA_WEBRTC_DIR` 默认 `$HOME/ScrcpyOverWebRTC`，信令服务、TURN 与设备端 Agent 的日志都写在该目录（`webrtcService.ts:36,652-658`）。

## 一次性票据与升级代理

- 票据签发先用 `LA_PLUMA_WEBRTC_USERNAME` / `LA_PLUMA_WEBRTC_PASSWORD`（缺省沿用上游出厂 `admin` / `admin123`，不生成不轮换）从回环地址登录上游换取 token；任何上游失败都返回固定 503，不回显上游错误或凭据（`webrtcSignalingGateway.ts:175-199`、`server/src/config/webrtcCredentials.ts:44-56`）。
- 票据 TTL 15 秒、未决上限 256 张：签发前清理过期票据，满了删除最旧；响应 `{ token, expiresInMs }` 且 `Cache-Control: no-store`（`webrtcSignalingGateway.ts:32-34,168-195`）。
- 升级校验（`parseClientUpgrade`，`webrtcSignalingGateway.ts:133-148`）：路径必须精确为 `<proxyPath>/connect_client`，`token` 非空，`deviceId` 可选且不超过 256 字符；不满足按 404 结束。
- 票据一次性：消费时读取后立即删除，已用或过期票据一律 401（`webrtcSignalingGateway.ts:202-208,221-224`）。
- 透传规则：`Host` 改写为上游地址，丢弃 `Origin` 与 `Proxy-Authorization`（上游拒绝浏览器 Origin 检查），其余头原样；上游路径携带真正的上游 token，浏览器只见代理票据（`webrtcSignalingGateway.ts:101-127,250-251`）。
- 上游 5 秒未接受连接返回 504，连接错误或提前关闭返回 502；viewer 登记或恢复失败返回 503（`webrtcSignalingGateway.ts:236-247,260-276`）。
- 网关关闭解除 upgrade 监听、清空票据并断开全部活动 socket，旧票据随之失效（`webrtcSignalingGateway.ts:292-305`）。
- 运行时对上游响应按 unknown 收窄：登录只接受非空字符串 token，`/devices` 兼容字符串与 `device_id` / `id` 对象条目，无效值按格式错误处理（`webrtcService.ts:683-686,698-717`）。

## signalingLoginGuard：票据签发的访问边界

票据入口前置 `optionalApiAuth` 与 `createSignalingLoginGuard`（`server/src/app.ts:103-107`）。

- 令牌模式（配置 `LA_PLUMA_TOKEN`）：令牌已由前置中间件把关，来源不构成额外边界，守卫只限流（`server/src/services/signalingLoginGuard.ts:67-82`）。
- 本地/LAN 模式（未配置令牌）只允许同源签发：无 `Origin` 的非浏览器调用视为同源；`Origin: null`、非法 URL、缺失或携带 userinfo/路径的 `Host` 一律拒绝；只比较主机名，端口与协议不参与（兼容本地开发代理与反向代理终止 TLS）。跨源返回 403 `AGENT_SIGNALING_ORIGIN_FORBIDDEN`（`signalingLoginGuard.ts:50-65,82-88`）。
- 签发频率独立于认证失败限流：每来源每 60 秒窗口 30 次，进程内固定窗口计数，键取 `req.ip`（未启用 trust proxy）；超限返回 429 并带 `Retry-After`（`server/src/app.ts:49-51,76-80`、`signalingLoginGuard.ts:90-98`、`server/src/utils/loginThrottle.ts:52-60`）。

认证与限流的通用规则（令牌头、失败限流、反向代理注意项）见[部署指南](../guides/deployment.md#跨域与访问来源)。

## viewer 会话与资源所有权

- `registerWebrtcViewer(deviceId)` 为每个网关连接登记一个租约：带设备标识的租约取消该设备待执行的回收计时器；不带标识的旧连接按全局 viewer 保守处理，阻止任何设备的自动回收（`webrtcService.ts:277-295`）。
- 最后一个 viewer 释放后按 `LA_PLUMA_WEBRTC_VIEWER_IDLE_GRACE_MS`（默认 3000ms）排队回收；Agent 刚启动先按 `LA_PLUMA_WEBRTC_VIEWER_STARTUP_GRACE_MS`（默认 15000ms）宽限（`webrtcService.ts:47-48,190-206,265-268`）。
- 回收前向上游确认：`/devices` 条目的 `client_count` / `clients` 显示仍有观看者时重新排队等待；旧版上游只返回设备 ID 字符串时仅依赖网关计数（`webrtcService.ts:1302-1326`）。
- 新 viewer 会取消排队中的回收；其租约的 `ready` 在建立上游连接前先确认（必要时恢复）设备端 Agent（`webrtcService.ts:196-206,287`、`webrtcSignalingGateway.ts:237-239`）。自动回收只停止匹配的设备，不关闭信令与 TURN 服务。
- 状态快照的 `ownership` 按 `managed`（本实例启动并登记）、`external`（启动前已存在或其它实例的资源）、`none`（未运行）标注 server、turn 与 agent；停止响应的 `released` 列出本次实际释放的 `server`、`turn`、`agent-deployment`、`device-agent`。停止只释放本实例拥有所有权的资源（`webrtcService.ts:73-99,983-1004,1037-1041`）。

## webrtcService：启停与进程所有权

- 安装、启动、停止全部经 `enqueueLifecycle` 串行执行；关闭一旦开始（`closeRequested` 或 draining），排队与在途步骤以 `WEBRTC_PREVIEW_CLOSED` 结束，不再派生资源（`webrtcService.ts:356-375`）。
- `startWebrtcServer`：上游可达则直接返回状态；否则先确保本地 TURN 监听，再以 `-host 0.0.0.0 -port 8443 -assets … -ice_servers … -tls=false` 启动二进制并等待 HTTP 就绪（默认 15s）（`webrtcService.ts:1125-1163`）。
- 受管 TURN：端口已被监听记为 external、不再启动；否则探测 `LA_PLUMA_WEBRTC_TURN_SERVER_PATH` 或常见安装位置启动 `turnserver`（无 TLS/DTLS，固定账号），默认 5s 内等待监听（`webrtcService.ts:909-952`）。ICE 列表优先 `LA_PLUMA_WEBRTC_ICE_SERVERS`，否则由 `turn:` / `stun:` 指向宿主 IPv4 拼出（`webrtcService.ts:884-889`）。
- `startWebrtcAgent`：等待服务就绪与鉴权 `/devices` 接口；同设备 Agent 已在运行时仅重新登记所有权（新 generation）；否则按需 `adb connect`、等待设备就绪（offline / unauthorized / no_permissions 各有具名错误码）、停止上一所有者的设备端 Agent，再经 `agentd/run.sh` 启动并等待设备出现在 `/devices` 且 `cloudphone-agent` 进程存在（默认 20s）。失败时终止部署子进程并清理设备端进程（`webrtcService.ts:1185-1249`）。
- 进程所有权：只终止本实例 spawn 的子进程；终止先杀进程组，SIGTERM 后 500ms 宽限期仍存活再 SIGKILL（`webrtcService.ts:381-395,50,973-981`）。所有就绪等待带显式时限与可注入轮询，失败抛具名错误码而不是把"还在等待"当成功（`waitForCondition`，`webrtcService.ts:464-511`）。
- 组合入口：`startWebrtc` 在同一队列内先启动信令服务再启动设备端 Agent；`stopWebrtc` 依次停止 Agent 与服务，汇总去重后的 `released` 列表（`webrtcService.ts:1368-1391`）。自动回收以"设备标识 + Agent 代次"匹配，只回收登记时的那一代 Agent（`webrtcService.ts:1307-1317`）。

## webrtcRuntime：发布包、平台二进制与宿主地址

- 平台二进制：仅支持 linux/darwin × amd64/arm64，路径为 `bin/<platform>_<arch>/webrtc-signaling`；其余组合在取得路径前抛 `WEBRTC_UNSUPPORTED_PLATFORM`（`webrtcRuntime.ts:61-73`）。
- 宿主地址：`LA_PLUMA_WEBRTC_HOST_IP` 显式覆盖且必须是 IPv4；否则优先选择与设备地址同网段的非内部 IPv4 网卡，再排除 docker/br-/veth/virbr/waydroid 网卡取第一个 LAN 地址，最后回退 127.0.0.1（`webrtcRuntime.ts:85-108`）。
- 发布包：固定上游 `cloudphone-v0.4.1.zip` 与 SHA-256 常量（`webrtcRuntime.ts:28-30`）。

## 安装与升级

- `installWebrtc`：二进制、assets 与 `agentd/run.sh` 齐备时直接返回状态；不存在 `build.sh`（发布包场景）时下载或读取 zip 并按固定 SHA-256 校验（本地 `LA_PLUMA_WEBRTC_ARCHIVE` 同样校验），解压后只复制 `bin`、`assets`、`agentd`，保留既有 checkout 与持久数据，临时目录总是清理，缺 `unzip` 时给出明确错误（`webrtcService.ts:1047-1069`、`webrtcRuntime.ts:116-158`）。
- 源码 checkout（存在 `build.sh`）时 chmod 后执行构建，非零退出抛 `WEBRTC_BUILD_FAILED` 并附输出尾部 4000 字符；构建后仍缺资源抛 `WEBRTC_BUILD_OUTPUT_MISSING`（`webrtcService.ts:1071-1118`）。
- 升级：发布包版本与校验值是编译期常量，安装按 `force: false` 复制、不覆盖既有文件（`webrtcRuntime.ts:142-148`）；更换上游版本需替换 `LA_PLUMA_WEBRTC_DIR`（默认 `$HOME/ScrcpyOverWebRTC`，Docker 为 `/root/ScrcpyOverWebRTC`，见[部署指南](../guides/deployment.md#docker-部署)）中的对应运行资源后重新安装。

## 关闭时的资源回收

- 预览关闭步骤以 `webrtc-preview` 注册到运行时生命周期（`webrtcService.ts:1350-1366`、`server/src/server.ts:260-264`）；关闭顺序为后台触发源与轮询 → 执行收尾 → HTTP 传输 → 预览资源（`docs/architecture/execution-lifecycle.md` §5.6）。
- HTTP 传输步骤拥有信令网关的关闭：`signalingGateway.close()` 断开观看连接并清空票据后，再停止接受连接并排空在途响应（`server/src/server.ts:197-218,296-297`）。
- 预览关闭置关闭标记并 abort 在途等待、取消 viewer 自动回收计时器、终止本实例的信令/TURN/Agent 部署/构建子进程，等待启动队列排空后再兜底 SIGKILL，不留孤儿进程（`webrtcService.ts:1328-1341`）。
- 关闭不通过 ADB 清理设备端 Agent，也不触碰没有所有权记录的外部资源（`webrtcService.ts:983-1004,1328-1341`）。

## 排障

- 日志：`LA_PLUMA_WEBRTC_DIR` 下 `la-pluma-webrtc-server.log`、`la-pluma-webrtc-agent.log`、`la-pluma-webrtc-turn.log`，子进程 stdout/stderr 追加写入（`webrtcService.ts:412-427,652-658`）。
- 票据入口 503 表示网关登录上游失败：两侧凭据必须来自同一组显式或默认值，只改一侧不会回退默认值（`webrtcCredentials.ts:44-56`、[部署指南](../guides/deployment.md#信令凭据与上游端口边界)）。
- 状态快照可用于定位归属：`ownership` 区分 managed/external/none；`iceServers` 为空表示未设置自定义列表且本地 TURN 未监听（`webrtcService.ts:884-889,1037-1041`）。快照同时给出 `url`（127.0.0.1）与 `lanUrl`（宿主 IPv4）地址及 `installed` / `built` 检测结果（`webrtcService.ts:1023-1044`）。
- 具名错误码对应阶段：启动等待 `WEBRTC_SERVER_START_TIMEOUT` / `WEBRTC_TURN_START_TIMEOUT` / `WEBRTC_DEVICES_API_TIMEOUT` / `WEBRTC_AGENT_START_TIMEOUT` / `WEBRTC_AGENT_STOP_TIMEOUT`；ADB 链路 `WEBRTC_ADB_NOT_FOUND`、`WEBRTC_ADB_READY_TIMEOUT` 与 `WEBRTC_ADB_DEVICE_OFFLINE` / `_UNAUTHORIZED` / `_FORBIDDEN` / `_NOT_FOUND`；关闭与构建见 `WEBRTC_PREVIEW_CLOSED`、`WEBRTC_BUILD_FAILED` 等 `createWebrtcError` 调用点。

## 边界与相关文档

- 前端预览会话、偏好与信令凭据的所有权见[前端架构与所有权](../frontend/README.md)；本文不描述预览 UI 与设备 Query。
- 部署操作、上游端口边界与鉴权/限流通用规则见[部署指南](../guides/deployment.md)；预览启停与执行租约的关系见[执行身份与生命周期契约](../architecture/execution-lifecycle.md)。
- 预览 router 只做端点映射，完整端点清单以代码与 [Agent API 使用指南](../api/agent.md)为准，本文不逐个列出。

## 测试入口

| 测试 | 固定的行为 |
| --- | --- |
| `server/src/services/__tests__/webrtcSignalingGateway.test.ts` | 票据签发与重放拒绝、过期票据与路径白名单、按设备登记 viewer、关闭清空票据 |
| `server/src/services/__tests__/webrtcPreviewOwnership.test.ts` | 外部资源不被停止、`ownership` 与 `released` 上报、关闭中止在途启动并终止本实例子进程 |
| `server/src/services/__tests__/webrtcService.test.ts` | 启动就绪等待与超时错误码 |
| `server/src/services/__tests__/webrtcRuntime.test.ts` | 平台判定与宿主地址选择 |
| `server/src/services/__tests__/webrtcViewerLifecycle.test.ts` | viewer 计时器、宽限与恢复 |
| `server/src/services/__tests__/signalingLoginGuard.test.ts` | 同源判定与签发限流 |
| `server/src/routes/__tests__/previewRoutes.test.ts` | 同源信令契约与请求收窄 |

回归命令与单文件定向执行方式见[服务端架构与请求契约](./README.md#测试入口)。
