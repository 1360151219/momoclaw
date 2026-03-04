FROM node:20-alpine

# 安装必要的系统工具
RUN apk update && apk add \
    git \
    curl \
    bash

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

# 切换到非root用户
USER node

# 设置环境变量
ENV NODE_ENV=production

# 运行代理
CMD ["node", "dist/index.js"]