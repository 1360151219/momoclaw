FROM node:20-alpine

# Copy uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# 安装必要的系统工具和构建依赖
RUN apk update && apk add \
    git \
    curl \
    bash \
    build-base \
    clang \
    compiler-rt

# Set CC to clang for uv managed python
ENV CC=clang
ENV CXX=clang++

# Install Python 3.13
# We need to explicitly set XDG_DATA_HOME so that uv installs python in a global location,
# rather than root's home directory.
ENV XDG_DATA_HOME=/usr/local/share

RUN uv python install 3.13 && \
    ln -s $(uv python find 3.13) /usr/local/bin/python3 && \
    ln -s /usr/local/bin/python3 /usr/local/bin/python && \
    chown -R node:node /usr/local/share/uv

# 设置 SHELL 环境变量
ENV SHELL=/bin/bash

# 设置工作目录
WORKDIR /app

# 复制配置文件和依赖
COPY package*.json tsconfig.json ./
RUN npm ci

# 复制应用代码
COPY --chown=node:node src/ ./src/
RUN npm run build

# 创建workspace目录
RUN mkdir -p /workspace/files /workspace/input /workspace/output /workspace/tmp \
    && chown -R node:node /workspace

USER node

# 设置环境变量
ENV NODE_ENV=production
# 指定 uv tool 安装目录为 node 用户的主目录
ENV UV_TOOL_DIR=/home/node/.local/share/uv/tools
# 指定 uv tool 产生的全局命令链接目录
ENV UV_TOOL_BIN_DIR=/home/node/.local/bin
# 将上述目录加入 PATH 环境变量中
ENV PATH="/home/node/.local/bin:${PATH}"

# 运行代理
CMD ["node", "dist/index.js"]