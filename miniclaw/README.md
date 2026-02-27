# MiniClaw AI Assistant

MiniClaw 是一个最小可用的 AI 助手，具有以下特性：

- **容器隔离**: AI 运行在 Docker 容器中，与主机隔离
- **多会话支持**: 支持多个独立对话会话
- **多模型支持**: 支持 Claude 和 OpenAI 兼容 API（如 Kimi）
- **文件操作**: 支持读取、写入、编辑文件
- **命令执行**: 支持在容器内执行 shell 命令

## 快速开始

### 1. 安装依赖

```bash
cd miniclaw/host
npm install

cd ../container
npm install
```

### 2. 配置环境变量

```bash
cd miniclaw
cp .env.example .env
# 编辑 .env 文件，填入 API Key
```

### 3. 构建容器镜像

```bash
cd miniclaw/host
npm run build
node dist/index.js build
```

### 4. 开始使用

```bash
# 创建会话
node dist/index.js new work

# 进入交互式对话
node dist/index.js chat work

# 或者直接启动（使用默认会话）
node dist/index.js
```

## 命令说明

### 会话管理

```bash
miniclaw new <id>           # 创建新会话
miniclaw list               # 列出所有会话
miniclaw switch <id>        # 切换会话
miniclaw delete <id>        # 删除会话
```

### 对话

```bash
miniclaw chat [session]     # 开始交互式对话
miniclaw                    # 快捷方式，使用当前会话
```

### 交互式命令

在对话中可以使用以下命令：

- `/model <name>` - 切换模型
- `/system <prompt>` - 修改 System Prompt
- `/clear` - 清空会话历史
- `/exit` - 退出

## 模型配置

支持两种 provider：

```bash
# Claude 模型
anthropic/claude-sonnet-4-6
anthropic/claude-opus-4-6

# OpenAI 兼容模型 (如 Kimi)
openai/kimi-latest
openai/gpt-4
```

在 `.env` 中设置默认模型：

```bash
MODEL=anthropic/claude-sonnet-4-6
```

或在对话中使用：

```
/model openai/kimi-latest
```

## 目录结构

```
miniclaw/
├── host/           # 主机端代码
├── container/      # 容器端代码
├── workspace/      # 工作目录（挂载到容器）
├── data/           # 数据目录（数据库）
└── .env            # 配置文件
```

## 安全说明

- AI 运行在隔离的 Docker 容器中
- 文件操作限定在 `./workspace` 目录
- 危险命令会被拦截
- API Key 仅存储在主机环境变量中

## License

MIT