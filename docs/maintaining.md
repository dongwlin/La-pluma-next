# 维护说明

> [← 返回 README](../README.md)

La Pluma Next 是 [mps233/La-pluma](https://github.com/mps233/La-pluma) 的社区维护分支，自 2026-10 起独立维护，不再跟随上游分支。

## 分支与合并

- `main` 是集成分支，已开启分支保护，要求 `Build and Publish GHCR Image` 的 `verify` 任务通过，并禁止 force push 和删除。
- 日常改动使用主题分支，通过 Pull Request 合并。

## 发布流程

1. 更新根目录及各子包的 `version`。
2. 提交版本变更。
3. 创建并推送 tag：

   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

4. GitHub Actions 会构建并推送 GHCR 镜像的 semver 标签和 `latest`。
5. 在 GitHub Releases 中补充变更说明。

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
