# GitHub Actions 配置说明

`ci.yml` 是 PR、main、版本 tag 和手动运行的统一入口；`container-build.yml` 复用两个架构的镜像构建和启动检查。

## 检查与发布

| 触发 | 执行内容 |
| --- | --- |
| PR、手动运行分支 | 源码、样式预算、浏览器集成和视觉检查；并行构建及启动 amd64、arm64 镜像，不推送 |
| main 推送 | 源码、样式预算、浏览器集成和视觉检查，不构建镜像 |
| `v*` tag | 源码校验与原生双架构构建并行；启动检查和 `verify` 通过后合并并发布镜像 |

浏览器检查直接复用同一 job 中 `pnpm verify` 生成的前端产物。tag 发布不重复运行 PR/main 的浏览器检查。检查固定执行，不维护按文件路径选择任务的策略。

分支保护继续要求 **`verify`**。它用几行 shell 汇总适用任务，任何失败、取消或意外跳过均阻止通过。PR 新提交取消旧运行；tag 发布不自动取消正在执行的同 tag 运行。

`checks` 校验发布 tag 与根 `package.json` 版本一致、提交已进入 `origin/main`。版本提升和打 tag 的步骤见[维护说明](../../docs/development/maintaining.md#发布流程)。

## 镜像标签

镜像地址为 `ghcr.io/<仓库所有者的小写名称>/<仓库名的小写名称>`。标签由 `docker/metadata-action` 的 semver 规则生成：正式版 `v0.0.6` 生成 `0.0.6`、`0.0`、`0` 和 `latest`；预发布如 `v0.1.0-rc.1` 只生成完整版本标签。

发布使用 `docker buildx imagetools create` 合并两个已验证的平台 digest。遵循 Docker 的普通可变标签语义，重跑会重新构建并更新对应标签；补发旧正式版本也会更新 `latest` 等别名。需要固定具体内容时使用 digest。

默认仅有 `contents: read`，只有 `release-build` 和 `publish` 申请 `packages: write`，使用内置 `GITHUB_TOKEN`，无需额外 secret。

## 容器与缓存

两个架构分别使用 `ubuntu-26.04`、`ubuntu-26.04-arm` 原生 runner，避免 QEMU。Dockerfile 的前端阶段固定为 `$BUILDPLATFORM`。

`scripts/ci/smoke-image.mjs IMAGE` 检查真实 `maa --version`、生产 entrypoint、健康接口、静态资源及 API 鉴权。使用临时数据、禁用外部网络和设备访问，并用 MaaCore 存在性 fixture 避免首次启动下载；不代表真实设备已验证。

构建读取 GHCR 的 `buildcache-amd64`、`buildcache-arm64`，只有发布任务写入。缓存缺失可冷构建，缓存导出失败不阻断镜像发布。Dockerfile 的 cache mount 只复用同一本地 builder，不自动进入外部层缓存。首次发布后，在 GitHub Package settings 中将镜像设为 Public，供用户和 fork PR 匿名读取。

## 本地复现

```bash
actionlint
pnpm verify
pnpm --filter la-pluma-next-client stylelint:ratchet

# 先拉取与已安装 Playwright 匹配的镜像
pnpm --filter la-pluma-next-client test:integration
pnpm visual

# 只在本机构建和检查，不推送
docker buildx build --load --platform linux/amd64 -t la-pluma-next:ci .
node scripts/ci/smoke-image.mjs la-pluma-next:ci
```
