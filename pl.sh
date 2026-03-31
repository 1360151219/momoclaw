#!/bin/bash

# =====================================================================
# 一键拉取阿里云 Docker 镜像并重命名脚本
# =====================================================================

# 1. 获取版本号：如果运行脚本时没传参数（$1为空），则默认使用 "latest"
# ${1:-latest} 是一种非常实用的简写：如果有传入第一个参数就用第一个参数，如果没有就用 latest
VERSION=${1:-latest}

# 2. 定义原始的阿里云镜像完整地址（拼接上版本号）
SOURCE_IMAGE="registry.cn-beijing.aliyuncs.com/strk2/momoclaw-agent:${VERSION}"

# 3. 定义目标镜像名称（也就是你代码 /host/src/container.ts 里需要的名称）
TARGET_IMAGE="momoclaw-agent:latest"

echo "🚀 第一步：开始从阿里云拉取镜像: ${SOURCE_IMAGE} ..."
# 执行 docker pull 命令拉取镜像
docker pull ${SOURCE_IMAGE}

# 检查拉取是否成功
# $? 表示上一个命令（即 docker pull）的执行结果状态码，0 表示成功，非 0 表示失败
if [ $? -ne 0 ]; then
  echo "❌ 错误：拉取镜像失败，请检查网络或者确认该镜像是否存在。"
  exit 1
fi

echo "✅ 拉取成功！"
echo "🏷️ 第二步：正在将镜像打标签（重命名）为代码需要的名称: ${TARGET_IMAGE} ..."
# 执行 docker tag 命令，给刚刚拉下来的长名字镜像贴上一个短名字的新标签
docker tag ${SOURCE_IMAGE} ${TARGET_IMAGE}

echo "🧹 第三步：清理原始的冗长标签，保持你的 Docker 列表干净 ..."
# 执行 docker rmi 命令删除长标签（因为有了新标签，这不会删除真实的镜像数据）
docker rmi ${SOURCE_IMAGE}

echo "🎉 全部完成！你的环境现在已经准备好了最新版的 ${TARGET_IMAGE} 。"
echo "👇 下面是当前的本地镜像列表，你可以核对一下："
# 打印出带有 momoclaw-agent 名字的镜像，让你亲眼看到重命名成功了
docker images | grep momoclaw-agent