# Browser MCP 深度分析报告

> 分析对象：`container/src/mcp/browser/` 模块\
> 日期：2026-04-20（基于最新代码更新）\
> 结合 momoclaw 整体通信架构分析

---

## 目录

1. [Momoclaw 通信架构概览](#1-momoclaw-通信架构概览)
2. [Browser MCP 技术分层与模块分析](#2-browser-mcp-技术分层与模块分析)
3. [已完成的优化项](#3-已完成的优化项)
4. [Profile Lock 报错深度分析与修复记录](#4-profile-lock-报错深度分析与修复记录)
5. [当前状态总结](#5-当前状态总结)

---

## 1. Momoclaw 通信架构概览

### 1.1 整体拓扑

```
┌─────────── 宿主机 (Host) ─────────────────────────────────┐
│                                                            │
│  FeishuGateway / WeixinGateway / CLI                       │
│       │                                                    │
│       ▼                                                    │
│  processChat()  ──► runContainerAgent()                    │
│       │                 │                                  │
│       │          docker exec -i + stdout pipe              │
│       │                 │                                  │
│  Host MCP Server        │                                  │
│  (Express + SSE)        │                                  │
│  port 51506             │                                  │
│       ▲                 │                                  │
└───────┼─────────────────┼──────────────────────────────────┘
        │                 │
        │  HTTP/SSE       │  docker exec
        │                 ▼
┌───────┼──── Docker Container (长生命周期) ──────────────────┐
│       │                                                    │
│  node /app/dist/index.js  (一次性 exec 进程)               │
│       │                                                    │
│  Claude Agent SDK query()                                  │
│       │                                                    │
│  ┌────┼── mcpServers ───────────────────────────┐          │
│  │    │                                         │          │
│  │  host_mcp ──► SSE ──► Host:51506            │          │
│  │  momoclaw_mcp (ArticleFetcher)  in-process   │          │
│  │  browser_mcp  (BrowserMCP)      in-process   │          │
│  │  context7     (HTTP)                         │          │
│  │  bilibili     (stdio 子进程)                  │          │
│  │  github       (HTTP)                         │          │
│  └──────────────────────────────────────────────┘          │
│                                                            │
│  Chromium (headless, detached, CDP on port 9222)           │
│  ↑ 跨多次 exec 持久存活                                     │
└────────────────────────────────────────────────────────────┘
```

### 1.2 核心通信机制

| 通信路径 | 协议/方式 | 说明 |
|---|---|---|
| Host → Container（创建容器） | `docker run -d ... tail -f /dev/null` | 长生命周期后台容器，用 `tail -f` 保活 |
| Host → Container（执行任务） | `docker exec -i ... node /app/dist/index.js` | 每次用户消息触发一个临时 Node 进程 |
| Container → Host（流式输出） | stdout + `__TOOL_EVENT__:{JSON}` 标记协议 | 文本流和工具事件混合传输 |
| Container → Host（最终结果） | 共享 Volume 文件 `result.json` | 通过文件系统传递结构化结果 |
| Container → Host MCP | HTTP SSE (端口 51506) | 定时任务等功能 |
| Container 内 → Chromium | Playwright CDP (WebSocket) | 浏览器自动化 |

### 1.3 关键生命周期特征

```
容器生命周期：  ════════════════════════════════════════════ (30 分钟空闲后销毁)
                     │              │              │
Node exec 进程：     ▓▓▓            ▓▓▓▓           ▓▓  (每次用户消息一个临时进程)
                     │              │              │
Chromium 进程：      ═══════════════════════════════  (跨 exec 持久存活)
                     │              │              │
Playwright 连接：    ▓▓▓            ▓▓▓▓           ▓▓  (每次 exec 内建立/复用，退出时丢弃)
```

**核心特征**：Node exec 进程是短命的（秒级），Chromium 进程是长命的（分钟级），它们通过持久化 Volume 上的 profile 目录和状态文件进行生命周期协调。

---

## 2. Browser MCP 技术分层与模块分析

### 2.1 模块架构（当前版本 v2.2.0）

```
container/src/mcp/browser/
├── index.ts          # 入口/编排层：MCP Server 定义、Tool 注册、SessionManager 连接管理
├── engine.ts         # 执行引擎层：CDP 连接、步骤 DSL 执行、资源路由拦截
├── types.ts          # 类型定义层：Zod schema 定义步骤 DSL
├── processManager.ts # 进程管理层：PID 检测、状态文件读写、锁文件清理
├── security.ts       # 安全层：Blocklist 读写、URL/IP 安全校验
└── constants.ts      # 配置层：路径常量、CDP 端点、UA、隐身选项
```

### 2.2 各模块职责详解

#### `index.ts` — 入口编排层

| 职责 | 实现 | 说明 |
|---|---|---|
| MCP Server 创建 | `createBrowserMcpServer()` | 使用 `createSdkMcpServer` 注册 6 个 tools |
| 连接管理 | `SessionManager` 类 | 封装 browser/context/page/endpoint，单例 `session` |
| Chromium 生命周期 | `browser_start/stop_chromium` | spawn detached 进程 + 状态文件 |
| CDP 就绪检测 | `waitForCdpReady()` | 轮询 `/json/version`，默认 30s 超时 |
| 状态安全读取 | `readAliveChromiumState()` | 读状态文件 + PID 存活检查，自动清理脏状态 |

**已注册的 Tools**：

| Tool | 功能 |
|---|---|
| `browser_chromium_status` | 查询 Chromium 运行状态（返回 `running: boolean`） |
| `browser_start_chromium` | 启动 headless Chromium，开启 CDP 端口 |
| `browser_stop_chromium` | 停止 Chromium，清理状态文件和 Singleton 锁 |
| `browser_get_blocklist` | 读取全局域名黑名单 |
| `browser_set_blocklist` | 写入全局域名黑名单 |
| `browser_run` | 通过 CDP 连接浏览器，执行 AI 动态生成的步骤 DSL |

#### `engine.ts` — 执行引擎层

| 职责 | 函数 | 说明 |
|---|---|---|
| CDP 连接 | `connectBrowser()` | 封装 `chromium.connectOverCDP()` |
| 资源拦截 | `applyLowMemoryRouting()` | 始终拦截 font/media，可选拦截 image |
| 步骤执行 | `runSteps()` | 9 种步骤类型的 switch-case 调度 |
| 导航安全 | `assertCurrentPageNotBlocked()` | 每次导航后校验当前 URL |

#### `types.ts` — 类型定义层

使用 `z.discriminatedUnion('type', [...])` 定义了 9 种步骤类型：

| 步骤类型 | 用途 | 关键参数 |
|---|---|---|
| `goto` | 页面导航 | `url`, `waitUntil` |
| `click` | 点击元素 | `selector` |
| `fill` | 填写表单 | `selector`, `value` |
| `press` | 按键操作 | `key`, `selector`(可选) |
| `waitForSelector` | 等待元素出现 | `selector`(必填), `timeoutMs` |
| `sleep` | 固定延时 | `ms`(必填) |
| `scroll` | 页面滚动 | `direction`, `amount` |
| `extract` | 提取文本 | `selector`, `attribute` |
| `screenshot` | 截图 | `fullPage` |

#### `processManager.ts` — 进程管理层

| 职责 | 函数 | 说明 |
|---|---|---|
| 进程存活检测 | `isPidAlive()` | `kill(pid, 0)` + `/proc/{pid}/stat` 排除僵尸 |
| 状态文件 CRUD | `read/write/clearChromiumState()` | JSON 文件持久化 PID、端口、路径 |
| PID 退出等待 | `waitForPidExit()` | 轮询等待，默认 5s 超时 |
| Singleton 锁清理 | `clearChromiumProfileLocks()` | 用 `lstatSync` 检测 + `rmSync` 删除 |
| 可执行文件查找 | `findChromiumExecutable()` | 候选路径扫描 |

#### `security.ts` — 安全层

| 职责 | 函数 | 说明 |
|---|---|---|
| Blocklist 持久化 | `read/writeGlobalBlocklist()` | workspace 下 JSON 文件 |
| URL 校验 | `assertUrlNotBlocked()` | 协议、私有 IP、域名匹配三重检查 |
| SSRF 防护 | `isBlockedIpv4()` | 覆盖 127/10/172.16/192.168/169.254/0 全部内网段 |

#### `constants.ts` — 配置层

| 常量 | 值/用途 |
|---|---|
| `WORKSPACE_DIR` | `/workspace/files` |
| `DEFAULT_CDP_ENDPOINT` | 环境变量或 `http://host.docker.internal:9222` |
| `REALISTIC_USER_AGENT` | Chrome 131 Windows UA |
| `STEALTH_CONTEXT_OPTIONS` | UA/locale/timezone/viewport 一致性配置 |
| `GLOBAL_BLOCKLIST_PATH` | blocklist.json 路径 |
| `CHROMIUM_STATE_PATH` | chromium-state.json 路径 |
| `DEFAULT_BLOCKED_HOST_PATTERNS` | 内置安全 blocklist（localhost/metadata 等） |
| `ChromiumState` 接口 | pid/port/cdpEndpoint/userDataDirRel/startedAt |

### 2.3 分层评价

| 维度 | 评价 | 备注 |
|---|---|---|
| 模块分层 | 良好 | 6 文件职责清晰，关注点分离 |
| DSL 设计 | 优秀 | Zod discriminatedUnion 类型安全，9 种步骤语义明确 |
| 安全设计 | 优秀 | SSRF 全覆盖 + 导航后二次校验 + 内置安全 blocklist |
| 进程管理 | 良好 | Singleton 锁清理已修复，能正确处理 dangling symlink |
| 连接管理 | 良好 | SessionManager 类封装，单一职责 |
| 错误处理 | 良好 | 关键路径已添加 warn 日志 |

---

## 3. 已完成的优化项

### 3.1 [P0] 修复 `clearChromiumProfileLocks` 无法清理 dangling symlink

**问题**：原代码用 `fs.existsSync()` 检测 `SingletonLock`。但 `SingletonLock` 是符号链接，当链接目标不存在时（旧容器已销毁），`existsSync` 返回 `false`，导致残留锁永远清不掉。

**修复**：改用 `fs.lstatSync()` — 它只检查链接本身是否存在，不跟踪目标。同时将空 catch 改为带错误码判断的 warn 日志。

```typescript
// processManager.ts — clearChromiumProfileLocks
try {
  fs.lstatSync(targetPath);  // 能检测到 dangling symlink
  fs.rmSync(targetPath, { recursive: true, force: true });
} catch (err: any) {
  if (err?.code !== 'ENOENT') {
    console.warn(`[browser-mcp] Failed to remove ${entry}:`, err?.message);
  }
}
```

### 3.2 [P0] spawn 前无条件清理 Singleton 锁

**问题**：原 `cleanupProfileLocksIfSafe()` 会再次检查状态文件，在某些竞态条件下可能跳过清理。

**修复**：在 `browser_start_chromium` 中 spawn 前直接调用 `clearChromiumProfileLocks()`，因为走到此处时已确认没有活着的同端口 Chromium。删除了多余的 `cleanupProfileLocksIfSafe` 函数。

### 3.3 [P2] 统一 `browser_chromium_status` 返回值类型

**问题**：`running` 字段在运行时为 `true`（boolean），未运行时为 `'false'`（string）。

**修复**：统一为 `running: boolean`，去除 `Boolean()` 冗余包装。

```typescript
// 修复前
{ running: Boolean(state) }  // 运行
{ running: 'false' }         // 未运行 ← string

// 修复后
{ running: true }            // 运行
{ running: false }           // 未运行 ← 统一 boolean
```

### 3.4 [P2] 拆分 `waitFor` 为 `waitForSelector` + `sleep`

**问题**：原 `waitFor` 步骤在没有 `selector` 时退化为 `waitForTimeout(timeout)`，默认等待 30 秒，语义不明，容易被 AI 误用。

**修复**：

- `waitForSelector` — 必须传 `selector`，等待元素出现
- `sleep` — 必须传 `ms`，固定延时

同步更新了 `types.ts`（schema）和 `engine.ts`（执行逻辑）。

### 3.5 [P3] 封装 SessionManager 类

**问题**：4 个模块级 `let` 变量散落在文件顶层，任何函数都可以随意读写。

**修复**：封装为 `SessionManager` 类，提供 `close()` 和 `getPage()` 两个方法，单例实例 `session`。所有原来直接操作变量的地方改为调用 `session.close()` / `session.getPage()`。

```typescript
class SessionManager {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private endpoint: string | undefined;

  async close(): Promise<void> { ... }
  async getPage(cdpEndpoint: string): Promise<Page> { ... }
}

const session = new SessionManager();
```

### 3.6 [P3] 删除 `cleanupZombieProcesses` 死代码

**问题**：`processManager.ts` 中定义了 `cleanupZombieProcesses()` 函数（约 45 行），但全项目无任何调用。

**修复**：直接删除。

---

## 4. Profile Lock 报错深度分析与修复记录

### 4.1 报错现象

```
The profile appears to be in use by another Chromium process on another computer.
```

### 4.2 Chromium Singleton 锁机制

Chromium 在 `--user-data-dir` 目录下创建 3 个 Singleton 文件实现 profile 互斥锁：

| 文件 | 类型 | 内容 |
|---|---|---|
| `SingletonLock` | **符号链接 (symlink)** | 指向 `hostname-pid`，标识占用者 |
| `SingletonSocket` | Unix domain socket 路径 | IPC 通信用 |
| `SingletonCookie` | 普通文件 | 随机 cookie 值 |

**Chromium 启动时的检查逻辑**：

1. 读取 `SingletonLock` symlink 的目标，解析出 `hostname` 和 `pid`
2. 如果 hostname **与当前主机不同** → 报 "another computer" 错误
3. 如果 hostname 相同但 pid 已死 → Chromium 自动接管（不报错）

### 4.3 结合 Momoclaw 架构的根因分析

根因是**三个条件同时满足**时触发的：

```
条件 1: 容器 hostname 变化
  docker rm -f 后重建容器，新容器获得新 hostname

条件 2: Singleton 锁文件残留
  旧容器被强杀，Chromium 没有机会清理锁文件
  profile 目录在持久化 Volume 上，跨容器保留

条件 3: 清理函数无法检测 dangling symlink [已修复]
  SingletonLock 是 symlink → 旧容器销毁后变成 dangling symlink
  fs.existsSync() 对 dangling symlink 返回 false → 清理被跳过
  ↓
  Chromium 启动 → 读到旧 hostname → 报错 "another computer"
```

### 4.4 已实施的修复

| # | 修复 | 状态 | 效果 |
|---|---|---|---|
| 1 | `clearChromiumProfileLocks` 改用 `lstatSync` | ✅ 已修复 | 能正确检测并删除 dangling symlink |
| 2 | spawn 前无条件清理 Singleton 锁 | ✅ 已修复 | 消除竞态条件下的清理遗漏 |

### 4.5 可选的进一步加固（当前无需实施）

| # | 措施 | 优先级 | 说明 |
|---|---|---|---|
| 3 | `docker run` 时设置固定 hostname `--hostname momoclaw` | P1 | P0 修复后已不必须，但可作为纵深防御 |
| 4 | 容器销毁前执行清理钩子 | P2 | 在 `docker rm -f` 前清理 Singleton 文件 |
| 5 | Chromium 启动参数 `--disable-features=LockProfileCookieDatabase` | P2 | 跳过锁检查，部分版本可能不支持 |

---

## 5. 当前状态总结

### 5.1 架构健康度

| 维度 | 评价 | 备注 |
|---|---|---|
| 模块分层 | ✅ 良好 | 6 文件职责清晰，关注点分离 |
| DSL 设计 | ✅ 优秀 | Zod discriminatedUnion，9 种步骤语义明确 |
| 安全设计 | ✅ 优秀 | SSRF 全覆盖 + 导航后二次校验 + 内置 blocklist |
| 进程管理 | ✅ 良好 | Singleton 锁清理正确处理 dangling symlink |
| 连接管理 | ✅ 良好 | SessionManager 封装，单一职责 |
| 错误处理 | ✅ 良好 | 关键路径有 warn 日志 |
| 类型一致性 | ✅ 良好 | `running` 统一为 boolean |

### 5.2 已修复项总览

| # | 问题 | 优先级 | 状态 |
|---|---|---|---|
| 1 | `clearChromiumProfileLocks` 无法检测 dangling symlink | **P0** | ✅ 已修复 |
| 2 | `cleanupProfileLocksIfSafe` 安全检查过于保守 | **P0** | ✅ 已修复（函数已删除） |
| 3 | `browser_chromium_status` 返回值类型不一致 | **P2** | ✅ 已修复 |
| 4 | `waitFor` 无 selector 时语义不明 | **P2** | ✅ 已修复（拆分为 waitForSelector + sleep） |
| 5 | 模块级可变状态未封装 | **P3** | ✅ 已修复（SessionManager 类） |
| 6 | `cleanupZombieProcesses` 死代码 | **P3** | ✅ 已修复（已删除） |

### 5.3 剩余可改进项

| # | 建议 | 优先级 | 说明 |
|---|---|---|---|
| 1 | `ChromiumState` 接口从 `constants.ts` 移到 `types.ts` | P3 | 语义更准确 |
| 2 | `docker run` 设置固定 hostname | P1 | 纵深防御，非必须 |
| 3 | 容器销毁前执行 Singleton 清理钩子 | P2 | 防止异常退出残留 |

---

*报告结束*
