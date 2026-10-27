# GitHub Actions 配置说明

`ci.yml` 是 PR、main、版本 tag 和手动运行的统一入口。`container-build.yml` 仅供它调用，复用镜像构建与启动检查，不独立触发校验。

## 检查与门禁

| Job | 职责 |
| --- | --- |
| `prepare` | actionlint（含 ShellCheck）、CI 策略回归、改动范围选择及发布版本校验 |
| `checks` | `pnpm verify`、样式预算，上传已验证的前端构建产物 |
| `browser` | 使用同一份产物运行跨页集成和 72 张视觉基线；失败上传截图与 trace |
| `build` | 只读权限下构建候选容器，验证真实生产入口、HTTP 和 CLI，不推送 |
| `release-build` | 原生双架构构建，按 digest 推送候选镜像；逐架构启动检查成功后上传 digest |
| `verify` | 始终汇总所有应执行的检查，任何失败、取消、意外跳过或缺失计划均阻断 |
| `publish` | `verify` 通过后合并两个已验证的 digest，发布版本并推进稳定渠道 |

分支保护继续要求名为 **`verify`** 的状态检查。它现在是汇总门禁，因此已有分支保护无需改名。`checks` 是源码校验 job，不能单独代替汇总门禁。

镜像步骤只定义在可复用工作流中；`build` 与 `release-build` 分开调用，以保证普通 PR 不获得发布写权限。中间产物允许同一次运行重试时覆盖，避免重跑产生同名 artifact 冲突。

## 按改动选择检查

工作流始终触发并产生汇总结果，不使用会让必选状态一直等待的 workflow 级 `paths` 过滤。

- 纯 Markdown、`docs/` 或 `screenshots/` 改动只执行 `prepare` 与 `verify`。
- 其他改动执行源码校验。客户端、共享依赖、CI 配置及浏览器入口改动还执行集成和视觉测试。
- PR 的生产源码、依赖或容器配置改动执行镜像启动检查。一般源码变化验证 amd64；Docker、包清单、锁文件、工作区或 CI 配置变化同时验证 arm64。
- main 推送按改动运行源码和浏览器检查，不构建或发布镜像。
- 版本 tag 全量校验，验证并发布 amd64 与 arm64。
- 手动运行分支时全量验证两种架构，不发布；手动运行合法版本 tag 时沿用发布规则。

路径与结果规则由 `scripts/ci/policy.mjs` 实现，Git diff 使用 `--no-renames`，文件移动会同时检查原路径和新路径。计划、版本和发布回归包含在 `pnpm test:ci` 与 `pnpm verify` 中。

## 发布版本与标签

发布 tag 必须满足：

1. 格式为 `vMAJOR.MINOR.PATCH`，可附 `-PRERELEASE`（如 `v0.1.0-rc.1`），不接受 build metadata。
2. 去掉 `v` 后与根 `package.json` 的版本完全一致。
3. 指向的提交已包含在 `origin/main` 中。

正式版 `v0.0.6` 发布 `0.0.6`，并按版本大小推进 `0.0`、`0` 和 `latest`。旧版本补丁或旧运行晚完成时，不能回退任何已有的稳定渠道。预发布仅生成完整标签（如 `0.1.0-rc.1`），不更新稳定渠道。

完整版本标签保持不可变。重跑同一版本时，只有原镜像的 revision 与版本一致才复用原镜像；不以重新构建的 digest 覆盖它。revision 冲突、注册表读取失败或现有渠道版本无法识别都会使发布失败。

`publish` job 按仓库串行执行，使用 `queue: max` 保留等待中的发布，在同一临界区内重新读取渠道版本并更新。PR 新提交会取消旧验证；正在执行的发布不会被新运行自动取消。

镜像地址为 `ghcr.io/<仓库所有者的小写名称>/la-pluma-next`。首次发布后须在 GitHub Package settings 中将镜像设为 Public，公开镜像和构建缓存才可供 fork PR 匿名读取。

版本提升与 tag 操作见[维护说明](../../docs/development/maintaining.md#发布流程)。

## 容器检查与缓存

构建使用 `ubuntu-26.04` 和 `ubuntu-26.04-arm` 原生 runner。前端阶段固定为 `$BUILDPLATFORM`，同一 builder 可以复用，但两个独立 runner 各构建一次。

`scripts/ci/smoke-image.mjs IMAGE` 先运行真实 `maa --version`，再通过真实 entrypoint 启动生产服务，检查 `/health`、首页引用的 JS/CSS，以及 API 鉴权。容器禁用外部网络、不连接设备，使用临时数据目录和只读的 MaaCore 存在性 fixture，避免首次安装下载。它不验证真实 MaaCore 安装、设备执行或 WebRTC。

跨运行缓存使用 GHCR 的 `buildcache-amd64`、`buildcache-arm64` 标签，只有经过版本及 main 归属校验的发布任务有写权限。PR 和分支手动运行只读缓存；缓存缺失时正常冷构建，导出失败不会阻断已构建的候选镜像。缓存标签不用于运行应用。

Dockerfile 的 npm/pnpm cache mount 仅复用同一本地 builder 的下载，不自动进入外部层缓存。GitHub Actions 的 branch/tag 缓存访问限制不适用于这里使用的 registry cache。

## 权限与本地复现

默认 `contents: read`；只有 `release-build` 和 `publish` 申请 `packages: write`。使用内置 `GITHUB_TOKEN`，无需将仓库默认 workflow 权限设置为读写。

```bash
pnpm test:ci
actionlint
pnpm verify
pnpm --filter la-pluma-next-client stylelint:ratchet

# 准备与已安装 Playwright 完全匹配的镜像后运行
pnpm --filter la-pluma-next-client test:integration
pnpm visual

# 只在本机构建并检查，不推送镜像
docker buildx build --load --platform linux/amd64 -t la-pluma-next:ci .
node scripts/ci/smoke-image.mjs la-pluma-next:ci
```
