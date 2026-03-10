# MomoClaw 飞书机器人配置指南

本文档指导你如何在飞书开放平台创建并配置 MomoClaw 机器人。

## 1. 创建应用

1. 登录 [飞书开放平台](https://open.feishu.cn/app)
2. 点击「创建企业自建应用」
3. 填写应用名称（例如：MomoClaw）和描述
4. 选择应用头像

## 2. 添加机器人能力

进入应用详情页：
1. 左侧菜单选择「添加应用能力」
2. 点击「机器人」卡片
3. 点击「添加」

## 3. 配置权限

进入「开发配置」→「权限管理」：

开通以下权限：

| 权限 | 说明 |
|------|------|
| `im:message` | 获取和发送消息 |
| `im:message.group_at_msg:readonly` | 读取群聊@消息 |
| `im:message.p2p_msg:readonly` | 读取私聊消息 |
| `im:message.group_msg` | 发送群聊消息 |

批量导入权限 JSON：
```json
{
  "scopes": {
    "tenant": [
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message.group_msg"
    ]
  }
}
```

## 4. 获取凭证

进入「凭证与基础信息」：

1. 找到 **App ID** 和 **App Secret**
2. 复制并填入 `.env` 文件：

```bash
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## 5. 配置事件订阅

进入「开发配置」→「事件与回调」：

1. 开启「接收消息」事件
2. 选择订阅方式：WebSocket
3. 无需配置 Request URL（使用 WebSocket 长连接）

订阅以下事件：
- `im.message.receive_v1` - 接收消息
- `im.message.message_read_v1` - 消息已读（可选）
- `im.chat.member.bot.added_v1` - 机器人被添加到群聊

## 6. 发布应用

1. 进入「应用发布」→「版本管理与发布」
2. 点击「创建版本」
3. 填写版本号（如 1.0.0）和更新说明
4. 申请发布
5. 等待企业管理员审核通过

## 7. 启动机器人

```bash
cd host
npm install  # 安装新依赖 ws
npm run build

# 方式1: 仅启动飞书机器人
node dist/index.js feishu

# 方式2: 开发模式
npm run dev -- feishu
```

## 功能特性

### 基础功能
- ✅ 私聊自动回复
- ✅ 群聊 @机器人 回复
- ✅ 富文本消息解析
- ✅ 消息引用（回复上下文）

### 内置命令
| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助信息 |
| `/clear` | 清空当前会话历史 |
| `/status` | 显示机器人状态 |

### 配置选项

```bash
# 基础配置
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxxx

# 可选配置
FEISHU_DOMAIN=feishu              # feishu 或 lark
FEISHU_AUTO_REPLY_GROUPS=oc_xxx   # 自动回复群组（逗号分隔）
FEISHU_LOG_LEVEL=info             # 日志级别
```

## 与 NeoClaw 的对比

| 特性 | MomoClaw | NeoClaw |
|------|----------|---------|
| 代码行数 | ~800 | ~2000+ |
| 依赖 | ws (1个) | @larksuiteoapi/node-sdk (重量级) |
| 流式卡片 | 简化版 | 完整支持 |
| 附件下载 | 文本标记 | 完整下载 |
| 表单交互 | ❌ | ✅ |
| 代码复杂度 | 低 | 高 |

MomoClaw 的飞书模块设计原则：**够用就好，简单可维护**。

## 常见问题

**Q: 为什么收不到消息？**
A: 检查以下几点：
1. App ID 和 App Secret 是否正确
2. 权限是否已开通并生效
3. 事件订阅是否已开启
4. 应用是否已发布并通过审核

**Q: 如何在群组中自动回复？**
A: 在 `.env` 中配置群组的 chat_id：
```bash
FEISHU_AUTO_REPLY_GROUPS=oc_xxxxxxxx,oc_yyyyyyyy
```

**Q: 如何获取 chat_id？**
A: 启动机器人后，在群里 @机器人 发送 `/status`，机器人会回复包含 chat_id 的状态信息。
