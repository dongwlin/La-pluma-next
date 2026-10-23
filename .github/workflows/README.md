# GitHub Actions 配置说明

## GHCR 镜像构建与发布

### 功能

- 自动运行前后端校验
- 自动构建多架构 Docker 镜像（amd64 + arm64）
- 推送到 GitHub Container Registry（GHCR）
- 推送 `v*` tag 时自动生成版本标签
- 使用 GitHub Actions 缓存加速构建

### 触发条件

1. **推送到 main 分支** → 构建并推送 `latest` 标签
2. **推送 tag（如 `v1.0.0`）** → 构建并推送版本标签
3. **Pull Request** → 仅校验和构建，不推送
4. **手动触发** → 在 Actions 页面手动运行

### 镜像地址

```text
ghcr.io/dongwlin/la-pluma-next:latest
ghcr.io/dongwlin/la-pluma-next:v1.0.0
ghcr.io/dongwlin/la-pluma-next:1.0
ghcr.io/dongwlin/la-pluma-next:1
```

`IMAGE_NAME` 使用 `${{ github.repository_owner }}/la-pluma-next`，因此 fork 后会自动跟随新的仓库所有者。

### 权限配置

Workflow 使用内置的 `GITHUB_TOKEN` 登录 GHCR，不需要额外 secrets。仓库需要保留：

- `Settings → Actions → General → Workflow permissions`
- 勾选 `Read and write permissions`（或至少允许 workflow 写 packages）

Workflow 已声明：

```yaml
permissions:
  contents: read
  packages: write
```

### 首次发布后

1. 打开 `https://github.com/dongwlin?tab=packages`
2. 找到 `la-pluma-next` 镜像
3. 在 Package settings 中把可见性改为 `Public`（否则拉取前需要 `docker login ghcr.io`）

本地拉取：

```bash
docker pull ghcr.io/dongwlin/la-pluma-next:latest
```

### 发布版本

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions 会自动构建并推送：

- `ghcr.io/dongwlin/la-pluma-next:v1.0.0`
- `ghcr.io/dongwlin/la-pluma-next:1.0`
- `ghcr.io/dongwlin/la-pluma-next:1`
- `ghcr.io/dongwlin/la-pluma-next:latest`
