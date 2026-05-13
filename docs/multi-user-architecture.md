# 微信多渠道多用户技术改造方案

## 一、现状分析

### 1.1 当前架构瓶颈

- `WeixinClient` 持有一份 `bot_token`，整个进程只有一个微信机器人身份
- `WeixinGateway` 单例运行，一个长轮询循环服务所有消息
- 用户隔离依赖 `wx_${userId}` 的 session 前缀，但只有一个微信登录身份

```
当前模型（单 bot 身份）：
┌─────────────────────────────────┐
│  Host Process                   │
│  ┌───────────────────────────┐  │
│  │  WeixinGateway (唯一)      │  │
│  │    ↓ 单一 bot_token        │  │
│  │  WeixinClient             │  │
│  │    ↓                      │  │
│  │  pollLoop → messages      │  │
│  └───────────────────────────┘  │
│          ↓                      │
│   session: wx_alice             │
│   session: wx_bob               │
│   session: wx_charlie           │
└─────────────────────────────────┘
```

问题：Alice 扫码登录后，Bob 无法用自己的身份启动另一个 bot 实例。整个系统只有一个微信 bot 身份。

### 1.2 已具备的基础设施

| 能力 | 状态 | 说明 |
|------|------|------|
| 多 session 并发 | ✅ 已有 | `SessionQueue` 保证同 session 串行，跨 session 并发 |
| 容器隔离 | ✅ 已有 | 每个 session 独立 Docker 容器 |
| cron 结果路由 | ✅ 已有 | `ChannelRegistry` 支持按 `channelType` + `channelId` 推送 |
| slash 命令 | ✅ 已有 | `core/commands/executor.ts` 跨渠道复用 |

## 二、改造目标

1. 支持多个微信用户同时接入，每个用户独立扫码登录
2. 不同接入用户的联系人 session、工作区文件、临时数据完全隔离
3. 向后兼容：单用户的配置方式仍然可用

## 三、核心方案

### 3.1 引入 接入用户抽象

每个扫码登录的微信用户就是一个独立的接入身份，没有"bot"这一层：

```
改造后（多用户接入）：
┌──────────────────────────────────────────────┐
│  Host Process                                 │
│  ┌──────────────────────────────────────┐     │
│  │  WeixinUserManager                   │     │
│  │                                      │     │
│  │  ┌──────────┐  ┌──────────┐         │     │
│  │  │ 用户 A   │  │ 用户 B   │  ...     │     │
│  │  │ (Alice)  │  │ (Bob)    │          │     │
│  │  │ Gateway  │  │ Gateway  │          │     │
│  │  │ Client   │  │ Client   │          │     │
│  │  │ pollLoop │  │ pollLoop │          │     │
│  │  └──────────┘  └──────────┘         │     │
│  └──────────────────────────────────────┘     │
│              ↓              ↓                 │
│   wx_A_alice   wx_A_bob   wx_B_eve ...       │
└──────────────────────────────────────────────┘
```

### 3.2 关键改造点

#### 3.2.1 Session ID 作用域

Session ID 从 `wx_${userId}` 变为 `wx_${wxUserId}_${fromUserId}`：

```
改造前:  wx_alice
改造后:  wx_A_alice     (wxUserId + fromUserId)
```

同一个微信联系人，在 Alice 的接入和 Bob 的接入下拥有完全独立的 session。

> **注意**：仅靠 session ID 前缀无法让 `container.ts` 的 `getOrStartContainer(sessionId)` 拿到 `wxUserId`。需要在 `Session` 接口新增 `wxUserId` 字段，创建 session 时写入，容器启动时从 session 对象中读取来决定挂载路径。

#### 3.2.2 ChannelContext 扩展

```typescript
// 改造前
interface ChannelContext {
  type: ChannelType;
  channelId: string;
}

// 改造后
interface ChannelContext {
  type: ChannelType;
  wxUserId: string;    // 新增：消息来自哪个接入用户（→ weixin_users.id）
  channelId: string;   // 含义不变
}
```

`wxUserId` 同时解决 cron 任务结果路由——CronService 执行任务时知道该推回哪个接入用户。

#### 3.2.3 ChannelRegistry 支持多用户实例

```typescript
// 改造前：weixin 类型只有一个 handler
channelRegistry.register(new WeixinCronHandler(config));

// 改造后：handler 按 accountId 注册
channelRegistry.register(accountId, new WeixinCronHandler(accountId, gateway));
channelRegistry.sendMessage(accountId, channelType, channelId, content);
```

### 3.3 数据库变更

微信渠道没有"bot"的概念——每一个扫码登录的微信用户就是一个独立的接入身份。表名用 `weixin_users`，映射表中用 `from_user_id` 指代给这个身份发消息的终端用户。

```sql
-- 1. 微信接入用户表（对接的每一个微信登录）
--    字段对应 BotTokenInfo 结构体，不做 JSON 大字段
CREATE TABLE weixin_users (
    id TEXT PRIMARY KEY,                  -- "wx_<shortId>"
    name TEXT NOT NULL,                   -- 显示名，如 "Alice 的微信"
    bot_token TEXT,                       -- BotTokenInfo.bot_token
    ilink_bot_id TEXT,                    -- BotTokenInfo.ilink_bot_id
    ilink_user_id TEXT,                   -- BotTokenInfo.ilink_user_id
    baseurl TEXT,                         -- BotTokenInfo.baseurl
    status TEXT NOT NULL DEFAULT 'pending', -- pending | active | error | stopped
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 2. 联系人→会话映射表
--    wx_user_id = 谁扫码登录的（→ weixin_users.id）
--    from_user_id = 微信 API 字段，发消息的人
CREATE TABLE weixin_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wx_user_id TEXT NOT NULL,             -- FK → weixin_users.id
    from_user_id TEXT NOT NULL,           -- 微信消息的 from_user_id
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(wx_user_id, from_user_id)
);
CREATE INDEX idx_wx_mappings_session ON weixin_mappings(session_id);
CREATE INDEX idx_wx_mappings_wx_user ON weixin_mappings(wx_user_id);

-- 3. 定时任务表增加 wx_user_id 列
ALTER TABLE scheduled_tasks ADD COLUMN wx_user_id TEXT;
```

### 3.4 WeChat 改造详情

#### 3.4.1 WeixinClient 多实例化

当前 `WeixinClient` 已经基本无状态（除了 `bot_token`），天然支持多实例：

```typescript
// host/src/weixin/client.ts 关键调整
// 1. token 文件路径按 accountId 区分
const TOKEN_FILE_PATH = (accountId: string) =>
  path.resolve(config.workspaceDir, accountId, 'credentials', '.wx_token.json');

// 2. WeixinClient 构造函数接收 accountId
class WeixinClient {
  constructor(config: WeixinConfig, accountId: string) { ... }
}
```

#### 3.4.2 WeixinGateway 多实例化

```typescript
// 每个 BotAccount 拥有独立的 Gateway
class WeixinGateway extends EventEmitter {
  private accountId: string;
  // ... 其余逻辑不变
}
```

多个 Gateway 共享同一个进程。polling 是 async 的，Node.js 事件循环天然支持多个并发长轮询。

#### 3.4.3 accountId 贯穿消息链路

```
WeixinGateway.pollLoop()
  → handleMessage(msg)
    → UnifiedMessage { wxUserId, fromUserId, text, ... }
      → WeixinBot.handleMessage()
        → getOrCreateSession(wxUserId, fromUserId)
          → weixin_mappings 查询/创建 (wx_user_id + from_user_id)
          → sessionId = `wx_${wxUserId}_${fromUserId}`
        → processChat({ channelContext: { type:'weixin', wxUserId, channelId } })
```

#### 3.4.4 用户管理

新增 `host/src/weixin/userManager.ts`：

```typescript
class WeixinUserManager {
  // 新增一个微信接入用户 → 返回 accountId
  async registerUser(name: string): Promise<string> { ... }

  // 列出所有已接入的微信用户
  listUsers(): WeixinUser[] { ... }

  // 启动指定用户的 Gateway（扫码 + 长轮询）
  async startUser(accountId: string): Promise<void> {
    const client = new WeixinClient(config, accountId);
    const gateway = new WeixinGateway(config, accountId);

    if (client.loadLocalToken()) {
      // 已有 token，直接启动轮询
    } else {
      // 需要扫码
      await client.loginWithQrcode();
    }

    channelRegistry.register(accountId, new WeixinCronHandler(accountId, gateway));
    gateway.start();
  }

  // 停止/删除
  async stopUser(accountId: string): Promise<void> { ... }
  async deleteUser(accountId: string): Promise<void> { ... }
}
```

#### 3.4.5 启动入口改造

```typescript
// host/src/index.ts
async function startWeixin(): Promise<boolean> {
  const manager = new WeixinUserManager();
  const users = manager.listUsers();

  // 如果没有接入用户，自动创建一个（向后兼容）
  if (users.length === 0) {
    const accountId = await manager.registerUser('默认微信');
    await manager.startUser(accountId);
    return true;
  }

  // 启动所有 active 状态的用户
  for (const u of users.filter(u => u.status === 'active')) {
    await manager.startUser(u.id);
  }
  return users.length > 0;
}
```

## 四、需要考虑的边界问题

### 4.1 资源竞争

| 问题 | 风险 | 方案 |
|------|------|------|
| 多用户同时有活跃联系人，容器数膨胀 | 每个 session 一个容器，内存 2G×N | ContainerManager 已有 30min 空闲回收；可加全局容器上限 |
| 多 Gateway 并发长轮询 | N 个用户 = N 个 35s 长轮询连接 | Node.js 异步 I/O，几十个连接无压力；可加 `maxAccounts` 限制 |
| DB 连接竞争 | better-sqlite3 同步单连接 | 已有 WAL 模式，足够 |

### 4.2 接入用户生命周期

```
创建 → pending（等待扫码）
  → active（扫码成功，轮询中）
  → error（token 过期/网络异常）
  → stopped（手动停止）

状态转换：
- pending → active: 扫码成功
- active → error: 轮询返回 ret=-14（session 过期）
- error → active: 重新扫码
- active → stopped: 手动关闭
- stopped → active: 手动重启
```

**关键**：token 过期时不能静默失败，终端打印清晰日志。

### 4.3 QR 码登录体验

多个用户需要扫码时，终端按顺序展示：

```
[Weixin] Account "Alice 的机器人" 等待扫码：
[QR Code Image]
[Weixin] Account "Bob 的机器人" 等待扫码：
[QR Code Image]
```

建议：按顺序扫码（阻塞式），一个用户登录成功后再提示下一个。

### 4.4 迁移兼容性

**现有单用户**：首次启动时检测旧 token 文件，自动创建 `default` 用户并迁移：

```typescript
// 启动时检测
if (fs.existsSync('./workspace/credentials/.wx_token.json')) {
  const oldToken: BotTokenInfo = JSON.parse(fs.readFileSync(...));
  const accountId = 'wx_default';
  // 将旧 token 写入 weixin_users 表（字段一一对应）
  db.insert('weixin_users', {
    id: accountId,
    name: '默认微信',
    bot_token: oldToken.bot_token,
    ilink_bot_id: oldToken.ilink_bot_id,
    ilink_user_id: oldToken.ilink_user_id,
    baseurl: oldToken.baseurl,
    status: 'active',
  });
  // 备份旧文件
  fs.renameSync(oldPath, oldPath + '.bak');
}
```

**现有 session 数据**：`default` 用户的 session ID 保持 `wx_<userId>` 不变，旧数据完全兼容。新用户的 session ID 为 `wx_<wxUserId>_<fromUserId>`。

### 4.5 Cron 任务归属

定时任务创建时携带 `ChannelContext`（含 `wxUserId`），执行完成后通过 `channelRegistry` 按 wxUserId 推回：

```typescript
// CronService.executeTask() → pushResultToChannel()
await channelRegistry.sendMessage(
  task.wxUserId,
  task.channelType,
  task.channelId,
  content,
);
```

接入用户被删除后，关联任务仍执行但推送失败（记录日志）。

### 4.6 文件系统隔离

#### 4.6.1 当前挂载情况（逐行审计 `container.ts`）

| 宿主机路径 | 容器内路径 | 当前隔离 | 用途 |
|-----------|-----------|---------|------|
| `data/claude-sessions/` | `/home/node/.claude` | 全局共享 | Claude SDK 持久化状态 |
| `workspace/` | `/workspace/files` | **全局共享** | 用户文件工作区 |
| `workspace/temp/momoclaw-session-${sessionId}` | `/workspace/session_tmp` | 按 session | 单次运行的 input/output/tmp |
| `<projectRoot>` | `/workspace/files/projects/momoclaw` | 全局共享 | 项目代码 |

#### 4.6.2 `~/.claude`：不需要隔离

SDK 内部用 `claudeSessionId` 做 namespace，不同 session 状态不会互相覆盖。全局配置（`.claude.json`）通过 Host 端 payload 注入管理。维持全局共享，无需改造。

#### 4.6.3 workspace 根目录按 account 隔离

整个 `workspace/` 目录树按 account 分根，一步到位：

```typescript
// container.ts getOrStartContainer()
// 改造前
const workspacePath = resolve(config.workspaceDir);

// 改造后
const workspacePath = join(resolve(config.workspaceDir), accountId);
```

目录结构变为：

```
workspace/
├── wx_account_A/                          ← Alice 的全部工作区
│   ├── files/                             ← /workspace/files
│   ├── temp/
│   │   ├── momoclaw-session-wx_A_alice/   ← session_tmp
│   │   └── wx_img_xxx.jpg                 ← 微信图片解密
│   └── credentials/
│       └── .wx_token.json                 ← bot token
├── wx_account_B/                          ← Bob 的全部工作区
│   ├── files/
│   ├── temp/
│   │   ├── momoclaw-session-wx_B_eve/
│   └── credentials/
│       └── .wx_token.json
```

涉及改动的文件（3 个）：

| 文件 | 改动 |
|------|------|
| `container.ts` | `workspacePath` 拼接 accountId |
| `weixin/gateway.ts` | 图片解密写入路径改为 `workspace/<accountId>/temp/` |
| `weixin/client.ts` | token 文件路径改为 `workspace/<accountId>/credentials/` |

`session_tmp` 无需额外处理——`sessionDir` 在 `workspacePath` 下，account 隔离自然生效。

#### 4.6.4 隔离等级总结

```
                    ┌──────────────┬──────────────┬──────────────┐
                    │  改造前       │  改造后       │  隔离层级     │
┌───────────────────┼──────────────┼──────────────┼──────────────┤
│ ~/.claude         │  全局共享     │  全局共享     │  SDK 自行管理│
│ workspace/*       │  全局共享     │  按 account  │  整个工作区   │
│ projects/momoclaw │  全局共享     │  全局共享     │  代码         │
└───────────────────┴──────────────┴──────────────┴──────────────┘
```

## 五、实施步骤

### Phase 1：数据层（1 天）

1. 创建 `weixin_users` 表
2. 创建 `weixin_mappings` 表
3. `sessions` 表加 `wx_user_id` 列
4. `scheduled_tasks` 表加 `wx_user_id` 列
5. 更新 `host/src/db/` 相关接口（CRUD for users + mappings）

### Phase 2：WeChat 多实例（2 天）

1. `Session` 接口加 `wxUserId` 字段，`createSession` 时写入
2. `ChannelContext` 加 `wxUserId` 字段
3. `WeixinClient` 支持 `accountId`，token 文件路径按 account 隔离
4. `WeixinGateway` 支持 `accountId`，图片临时目录按 account 隔离
5. `weixin/bot.ts`：`getOrCreateSession(wxUserId, fromUserId)`，使用 `weixin_mappings` 表
6. 实现 `WeixinUserManager`（注册/启动/停止/删除接入用户）
7. `WeixinCronHandler` 按 accountId 持有对应 gateway 引用
8. `ChannelRegistry` 支持 `register(accountId, handler)` 和 `sendMessage(accountId, ...)`

### Phase 3：容器 & 文件系统（1 天）

1. `container.ts`：`workspacePath` 拼接 accountId（从 session 读取）
2. `host/src/index.ts` 启动逻辑改造（多用户启动 + 旧数据迁移）
3. 旧 token 文件自动迁移到 `workspace/<accountId>/credentials/`

### Phase 4：测试（1 天）

1. 单用户回归测试
2. 多用户并发：两个接入用户各有联系人发消息，验证 session/容器/文件互不干扰
3. Token 过期后重新扫码恢复
4. Cron 任务跨用户路由正确性

## 六、不做的事情

- **不做** WeChat 群聊成员级别的 session 拆分（群聊内所有人共享一个 session，微信 bot API 不区分群内发送者）
- **不做** 接入用户间的资源共享/转移（session 严格隔离）
- **不做** 飞书渠道的多 App 改造（本次只聚焦微信）
- **不做** Web 管理后台

---

> **总结**：核心思路是 `weixin_users` 接入层 + `accountId` 贯穿全链路。改造量约 5 天，4 个 Phase。关键技术点：多 Gateway 并发长轮询、workspace 按 account 分根、旧数据平滑迁移。
