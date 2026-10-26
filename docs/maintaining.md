# 维护说明

> [← 返回 README](../README.md)

La Pluma Next 是 [mps233/La-pluma](https://github.com/mps233/La-pluma) 的社区维护分支，自 2026-10 起独立维护，不再跟随上游分支。

## 分支与合并

- `main` 是集成分支，已开启分支保护，要求 `Build and Publish GHCR Image` 的 `verify` 任务通过，并禁止 force push 和删除。
- 日常改动使用主题分支，通过 Pull Request 合并。

## 发布流程

1. 在 `main` 上提升版本。该命令会同时创建提交和 `v` 前缀的 annotated tag，只修改根目录 `package.json`（子包不参与发布，保持 `0.0.0`），并要求工作区干净：

   ```bash
   pnpm version patch -m "chore(release): v%s"
   ```

   首个版本用显式版本号（`pnpm version 0.0.1`），之后用 `patch` / `minor` / `major`。

2. 推送提交与 tag：

   ```bash
   git push --follow-tags origin main
   ```

3. GitHub Actions 的 `verify` 通过后，构建并推送 GHCR 镜像的 semver 标签（如 `0.0.1`、`0.0`、`0`）。`latest` 只在推送到默认分支时更新，推送 tag 不会改动它。
4. 在 GitHub Releases 中补充变更说明。

## 容器镜像

- 镜像地址：`ghcr.io/dongwlin/la-pluma-next`
- 首次发布后，在 GitHub Package settings 中把镜像可见性设为 `Public`；私有镜像拉取前需要 `docker login ghcr.io`。

## 兼容性标识

项目名称已改为 La Pluma Next，但以下内部标识保持不变，避免破坏已有部署和配置：

- 环境变量前缀 `LA_PLUMA_*`
- CSS 类名 `la-pluma-*`、localStorage key `la-pluma-*`
- HTTP 头 `x-la-pluma-*`
- Agent API 标识 `la-pluma-agent-api`

## 外部运行时依赖

WebRTC 安装会从 `hqw700/ScrcpyOverWebRTC` 的 GitHub Release 下载 `cloudphone-v0.4.1.zip`，并校验固定 SHA-256。为保证长期可安装，建议把该压缩包镜像到本仓库的 Release，并在上游资产失效时更新 `server/services/webrtcRuntime.js` 中的 `RELEASE_URL`。

## 项目文档与过程档案

主仓库的 `docs/` 只维护现行架构、公开契约、兼容约束、开发/运维方法及可复现测试入口。迁移任务、实施日志、逐任务复核、一次性测试结果与性能原始采样属于过程档案，不复制到产品文档索引中。需要长期保留的结论应先转写为当前约束，并由实现或回归测试支持。

性能采样结果默认写入 Git 忽略的 `client/test-results/performance/`；长期文档只描述采样方法与指标限制，不能把某次基准数据当作未来版本的持续保证。
