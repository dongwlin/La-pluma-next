# 前端产物与目标架构无关，固定在构建机架构上执行，避免 QEMU 下运行 tsc/vite。
# 同一 builder 可复用此阶段；两个原生 runner 各自构建一次。
FROM --platform=$BUILDPLATFORM node:24-alpine AS frontend-builder

ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=${VITE_BASE_PATH}

# 依赖源：CI（GitHub 美区 runner）用官方源最快；在国内本地构建时可传
# --build-arg NPM_REGISTRY=https://registry.npmmirror.com 加速。
ARG NPM_REGISTRY=https://registry.npmjs.org

RUN --mount=type=cache,target=/root/.npm \
    npm install -g pnpm@12.6.0 --registry=${NPM_REGISTRY}

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY client/package.json ./client/
COPY server/package.json ./server/

# store 挂载复用同一个本地 builder 的下载；CI 的跨 runner 复用依靠 registry 层缓存。
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter la-pluma-next-client... \
    --registry=${NPM_REGISTRY}

COPY client/ ./client/

RUN pnpm --filter la-pluma-next-client build

FROM node:24-slim

ARG VITE_BASE_PATH=/
ARG BUILD_REVISION=unknown
ARG NPM_REGISTRY=https://registry.npmjs.org
# maa-cli 固定到上游 release，避免 main 分支安装脚本与 stable 渠道漂移。
# 版本和 SHA-256 来源：https://github.com/MaaAssistantArknights/maa-cli/releases/tag/v0.7.8
ARG MAA_CLI_VERSION=0.7.8
ARG MAA_CLI_SHA256_AMD64=8ac10686a36bd227cd7b2f2625652cb8bbcf2b9ea001fc88d788030fedb05fbf
ARG MAA_CLI_SHA256_ARM64=7aadb2ee402694c5c9f7ff0d391d546f2e71e02e32f0d545ad4a18df3e4510b4
ARG TARGETARCH

LABEL org.opencontainers.image.title="La Pluma Next" \
      org.opencontainers.image.description="MAA CLI 的现代化 WebUI 与本地 Agent 控制台" \
      org.opencontainers.image.source="https://github.com/dongwlin/La-pluma-next" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.revision="${BUILD_REVISION}"

WORKDIR /app

RUN --mount=type=cache,target=/root/.npm \
    npm install -g pnpm@12.6.0 --registry=${NPM_REGISTRY}

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    wget \
    git \
    unzip \
    ca-certificates \
    android-tools-adb \
    libatomic1 \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/maa-cli/bin

RUN set -eux; \
    case "${TARGETARCH:-$(uname -m)}" in \
      amd64|x86_64) maa_target="x86_64-unknown-linux-gnu"; maa_sha256="${MAA_CLI_SHA256_AMD64}" ;; \
      arm64|aarch64) maa_target="aarch64-unknown-linux-gnu"; maa_sha256="${MAA_CLI_SHA256_ARM64}" ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH:-$(uname -m)}" >&2; exit 1 ;; \
    esac; \
    wget -qO /tmp/maa-cli.tar.gz "https://github.com/MaaAssistantArknights/maa-cli/releases/download/v${MAA_CLI_VERSION}/maa_cli-v${MAA_CLI_VERSION}-${maa_target}.tar.gz"; \
    echo "${maa_sha256}  /tmp/maa-cli.tar.gz" | sha256sum -c -; \
    mkdir -p /tmp/maa-cli; \
    tar -xzf /tmp/maa-cli.tar.gz -C /tmp/maa-cli; \
    install -m 0755 /tmp/maa-cli/maa /opt/maa-cli/bin/maa; \
    rm -rf /tmp/maa-cli /tmp/maa-cli.tar.gz; \
    ln -s /opt/maa-cli/bin/maa /usr/local/bin/maa; \
    maa --version

RUN mkdir -p /root/.config/maa

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY client/package.json ./client/
COPY server/package.json ./server/

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter la-pluma-next-server... \
    --registry=${NPM_REGISTRY}

COPY server/ ./server/

COPY --from=frontend-builder /app/client/dist ./client/dist

RUN mkdir -p /app/server/data/user-configs

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000 \
    LA_PLUMA_BASE_PATH=${VITE_BASE_PATH} \
    MAA_CONFIG_DIR=/root/.config/maa \
    DOCKER_ENV=true

# 健康检查：首次启动由 entrypoint 执行 maa install --force，可能持续 5-10 分钟，
# start-period 必须覆盖该窗口，避免安装期间被反复判为 unhealthy。
HEALTHCHECK --interval=30s --timeout=10s --start-period=600s --retries=3 \
    CMD scheme=http; if [ -n "$LA_PLUMA_HTTPS_CERT_PATH" ]; then scheme=https; fi; curl -fk "$scheme://localhost:${PORT:-3000}/health" || exit 1

WORKDIR /app/server
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.ts"]
