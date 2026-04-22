# MomoClaw AI Assistant

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue.svg)](https://www.docker.com/)

MomoClaw 是一个最小可用的 AI 助手。其核心理念是通过 Docker 容器隔离 AI 的运行环境，从而在提供强大命令执行和文件操作能力的同时，保证主机系统的安全性。

## ✨ 特性

- **🛡️ 容器隔离**: AI 运行在隔离的 Docker 容器中，保障主机安全。
- **💬 多会话支持**: 支持管理和切换多个独立的对话会话。
- **🧠 多模型支持**: 内置支持 Claude 3 系列和兼容 OpenAI API 格式的模型（如 Kimi、GPT-4 等）。
- **📂 文件操作**: 允许 AI 在限定的工作区（Workspace）内读取、写入和编辑文件。
- **💻 命令执行**: 支持在容器内安全地执行 Shell 命令。
- **🔌 MCP 支持**: 内置 MCP (Model Context Protocol) 服务，支持主流内容平台（微信、知乎、掘金等）的文章抓取。

## 🛠️ 前置要求

在运行 MomoClaw 之前，请确保您的系统已安装：

- [Node.js](https://nodejs.org/) (推荐 v18 或更高版本)
- [Docker](https://www.docker.com/) (用于运行隔离的 AI 容器)

## 🚀 快速开始

### 1. 安装与构建

MomoClaw 提供了便捷的 npm scripts 来一键安装所有依赖并构建容器镜像：

```bash
# 一键安装依赖并构建项目（包括构建 Docker 镜像）
npm run setup
```
> **提示**：该命令会自动执行 `npm install` 并编译主机与容器代码，最后执行 `docker build`。

### 2. 配置环境变量

复制环境配置模板并填入您的 API Key：

```bash
cp .env.example .env
```
> **提示**: 请编辑 `.env` 文件，填入您的 Claude 或兼容 OpenAI 格式的 API 密钥。

### 3. 开始使用

MomoClaw 提供了以下便捷的启动命令：

```bash
# 启动默认交互式对话
npm run start

# 或者明确启动 chat 模式
npm run chat
```

### 4. 定时任务

推荐创建 `daily-greeting` skill 定时任务，每天早上 8:30 调用。

```
帮我创建一个定时任务，每天早上 8:30 调用 `daily-greeting` skill。
```

## ☁️ 服务器部署 (PM2)

如果您希望在服务器上长期后台运行（例如运行飞书或微信机器人），推荐使用 [PM2](https://pm2.keymetrics.io/) 来管理进程。项目中已经为您配置好了 `ecosystem.config.js`。

### 1. 全局安装 PM2

如果您还没有安装 PM2，请先在服务器上全局安装：

```bash
npm install pm2 -g
```

### 2. 使用 PM2 启动项目

**方式：通过 npm 脚本启动（推荐，更符合习惯）**
```bash
# 启动默认助手
pm2 start npm --name "momoclaw-default" -- run start

# 启动飞书机器人
pm2 start npm --name "momoclaw-feishu" -- run start:feishu

# 启动微信机器人
pm2 start npm --name "momoclaw-weixin" -- run start:weixin

# 启动飞书/微信机器人
pm2 start npm --name "momoclaw" -- run start:all
```

### 3. 常用 PM2 管理命令

- **查看运行状态**：`pm2 list`
- **查看实时日志**：`pm2 logs` (或者指定某个服务 `pm2 logs momoclaw-feishu`)
- **重启服务**：`pm2 restart momoclaw-feishu`
- **停止服务**：`pm2 stop momoclaw-feishu`
- **设置开机自启**：
  ```bash
  pm2 save
  pm2 startup
  ```

## 📖 命令行指南

MomoClaw 也可以通过直接调用 `host/dist/index.js` 来进行精细化的会话管理：

### 会话管理

```bash
node host/dist/index.js new <id>           # 创建新会话
node host/dist/index.js list               # 列出所有会话
node host/dist/index.js switch <id>        # 切换会话
node host/dist/index.js delete <id>        # 删除会话
```

### 交互式对话内命令

在进入对话模式后，您可以使用以下内置命令：

- `/model <name>` - 切换当前使用的模型
- `/system <prompt>` - 动态修改 System Prompt
- `/clear` - 清空当前会话历史
- `/exit` - 退出对话

## 🤖 模型配置

MomoClaw 支持:

**1. Claude 模型**
- `anthropic/claude-3-5-sonnet-20241022`
- `anthropic/claude-3-opus-20240229`

您可以在 `.env` 文件中设置默认模型：
```env
MODEL=anthropic/claude-3-5-sonnet-20241022
```

## 📁 目录结构

```text
momoclaw/
├── host/           # 主机端代码 (负责对话管理、API 调用)
├── container/      # 容器端代码 (负责隔离环境中的命令执行和文件操作)
├── workspace/      # 工作目录 (挂载到容器内部的安全沙箱)
├── data/           # 数据目录 (SQLite 数据库文件存储)
└── .env            # 环境变量配置
```

## 🔒 安全说明

安全是 MomoClaw 的核心设计原则：

- **隔离运行**: AI 的所有操作都在隔离的 Docker 容器中执行。
- **路径限制**: 文件操作被严格限制在 `./workspace` 目录内。
- **命令拦截**: 危险系统命令会被主动拦截。
- **密钥安全**: API Key 等敏感信息仅存储在主机的环境变量中，不会泄露给容器环境。

## 🤝 参与贡献

欢迎提交 Issue 和 Pull Request！在提交 PR 之前，请确保通过所有测试。

## 📄 License

本项目基于 MIT 协议开源。
