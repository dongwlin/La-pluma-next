# ============================================
# 用于 GHCR 发布的 Dockerfile
# 在镜像内构建前端，不依赖本地环境
# ============================================

# ============================================
# 阶段 1: 构建前端
# ============================================
FROM node:22-alpine AS frontend-builder

ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=${VITE_BASE_PATH}

# 安装 pnpm（版本与 package.json 的 packageManager 保持一致）
RUN npm install -g pnpm@12.6.0 --registry=https://registry.npmmirror.com

WORKDIR /app

# 复制工作区依赖清单，充分利用 Docker 层缓存
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY client/package.json ./client/
COPY server/package.json ./server/

# 安装前端依赖（使用国内镜像加速）
RUN pnpm install --frozen-lockfile --filter la-pluma-next-client... \
    --registry=https://registry.npmmirror.com

# 复制前端源代码
COPY client/ ./client/

# 构建前端
RUN pnpm --filter la-pluma-next-client build

# ============================================
# 阶段 2: 后端运行环境 + MAA CLI
# ============================================
FROM node:22-slim

ARG VITE_BASE_PATH=/
ARG BUILD_REVISION=unknown

LABEL org.opencontainers.image.title="La Pluma Next" \
      org.opencontainers.image.description="MAA CLI 的现代化 WebUI 与本地 Agent 控制台" \
      org.opencontainers.image.source="https://github.com/dongwlin/La-pluma-next" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${BUILD_REVISION}"

WORKDIR /app

# 安装 pnpm（版本与 package.json 的 packageManager 保持一致）
RUN npm install -g pnpm@12.6.0 --registry=https://registry.npmmirror.com

# 安装必要的系统依赖
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    wget \
    unzip \
    ca-certificates \
    android-tools-adb \
    libatomic1 \
    && rm -rf /var/lib/apt/lists/*

# 创建 MAA CLI 持久化目录
RUN mkdir -p /opt/maa-cli/bin

# 使用官方安装脚本安装 MAA CLI
RUN wget -qO- https://raw.githubusercontent.com/MaaAssistantArknights/maa-cli/main/install.sh | \
    MAA_INSTALL_DIR=/opt/maa-cli/bin bash && \
    ln -s /opt/maa-cli/bin/maa /usr/local/bin/maa && \
    maa --version

# 创建 MAA 配置目录
RUN mkdir -p /root/.config/maa

# 复制工作区依赖清单
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY client/package.json ./client/
COPY server/package.json ./server/

# 安装后端生产依赖（使用国内镜像加速）
RUN pnpm install --frozen-lockfile --prod --filter la-pluma-next-server... \
    --registry=https://registry.npmmirror.com

# 复制后端源代码
COPY server/ ./server/

# 从构建阶段复制前端构建产物
COPY --from=frontend-builder /app/client/dist ./client/dist

# 创建数据目录
RUN mkdir -p /app/server/data/user-configs

# 复制启动脚本
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 暴露端口
EXPOSE 3000

# 设置环境变量
ENV NODE_ENV=production \
    PORT=3000 \
    LA_PLUMA_BASE_PATH=${VITE_BASE_PATH} \
    MAA_CONFIG_DIR=/root/.config/maa \
    DOCKER_ENV=true

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD scheme=http; if [ -n "$LA_PLUMA_HTTPS_CERT_PATH" ]; then scheme=https; fi; curl -fk "$scheme://localhost:${PORT:-3000}/health" || exit 1

# 启动服务器
WORKDIR /app/server
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
