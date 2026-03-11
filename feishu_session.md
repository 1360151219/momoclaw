# Session设计规范

```
完整流程图
┌─────────────────────────────────────────────────────────────────────────────┐
│                          用户发送消息到飞书                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 飞书服务器 ──────► WebSocket 推送 ──────► im.message.receive_v1 事件         │
│                                                                              │
│  事件数据包含:                                                                │
│  - event.message.chat_id (chatId)          ← 群聊/私聊唯一标识               │
│  - event.message.message_id                ← 消息唯一ID                      │
│  - event.message.content                   ← 消息内容                        │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                    FeishuGateway.handleMessageEvent()                        │
│                         gateway.ts:169                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         parseMessage() 解析                                  │
│                        receiver.ts (解析原始事件)                            │
│                                                                              │
│  提取关键字段:                                                                │
│  - message.chatId = event.message.chat_id                                    │
│  - message.chatType = "p2p" 或 "group"                                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
                    ┌─────────────────────────────┐
                    │    是否是 / 开头的命令?      │
                    └─────────────────────────────┘
                         │              │
                    是 ▼              ▼ 否
           ┌───────────────┐    ┌───────────────┐
           │ handleCommand │    │ handleStreamingMessage │
           └───────────────┘    └───────────────┘
                  │                      │
                  ▼                      ▼
      ┌──────────────────┐     ┌──────────────────┐
      │ /new 命令特殊处理 │     │ 调用 getOrCreate │
      │ - 删除旧 session │     │ Session(message) │
      │ - 创建带时间戳的 │     └──────────────────┘
      │   新 sessionId   │              │
      └──────────────────┘              ▼
                              ┌──────────────────────────────────────────┐
                              │      getOrCreateSession(message)         │
                              │            gateway.ts:482                │
                              └──────────────────────────────────────────┘
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
                    │                         │                         │
                    ▼                         ▼                         ▼
         ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
         │  1. 检查内存缓存  │      │  2. 检查DB映射   │      │  3. 创建新Session │
         │  sessionCache   │      │ feishu_mappings │      │                 │
         │                 │      │                 │      │                 │
         │ Map<chatId,     │      │ 表结构:         │      │ 生成 sessionId: │
         │     sessionId>  │      │ - chat_id (PK)  │      │ feishu_${chatId}│
         │                 │      │ - session_id    │      │ _${timestamp}  │
         │ 命中? ──► 返回   │      │ - created_at    │      │                 │
         │                 │      │ - updated_at    │      │ 同时保存:       │
         │ 失效? ──► 删除   │      │                 │      │ - sessionCache  │
         │  + deleteMapping │      │ 命中? ──► 更新   │      │ - feishu_mappings│
         │                 │      │ 缓存并返回       │      │                 │
         └─────────────────┘      │                 │      └─────────────────┘
                                  │ 失效? ──► 删除   │
                                  └─────────────────┘
                                              │
                                              ▼
                              ┌──────────────────────────────────────────┐
                              │              返回 Session 对象            │
                              │  (包含 id, name, systemPrompt 等)         │
                              └──────────────────────────────────────────┘
                                              │
                    ┌─────────────────────────┴─────────────────────────┐
                    │                                                   │
                    ▼                                                   ▼
         ┌────────────────────┐                              ┌────────────────────┐
         │   /new 命令流程     │                              │   普通消息流程      │
         │                     │                              │                     │
         │ 1. 获取旧 sessionId │                              │ 1. 获取历史消息     │
         │    (从缓存/DB)      │                              │    getSessionMessages│
         │                     │                              │                     │
         │ 2. deleteSession()  │                              │ 2. 发送到 AI 处理   │
         │    (删除 sessions   │                              │    runContainerAgent │
         │     表中的记录)     │                              │                     │
         │                     │                              │ 3. 保存 AI 回复     │
         │ 3. createSession()  │                              │    addMessage()     │
         │    生成新 sessionId:│                              │                     │
         │    feishu_${chatId} │                              │                     │
         │    _${Date.now()}   │                              │                     │
         │                     │                              │                     │
         │ 4. 更新映射:        │                              │                     │
         │    - sessionCache   │                              │                     │
         │      .set(chatId,   │                              │                     │
         │       newSessionId) │                              │                     │
         │                     │                              │                     │
         │    - setMapping()   │                              │                     │
         │      (INSERT/UPDATE │                              │                     │
         │       feishu_       │                              │                     │
         │       mappings)     │                              │                     │
         │                     │                              │                     │
         └────────────────────┘                              └────────────────────┘
存储层架构（双层缓存）
┌─────────────────────────────────────────────────────────────┐
│                      内存缓存层                               │
│              Map<string, string> sessionCache                │
│                                                              │
│  Key: chatId (如: oc_6918f775b4eb133907e85382c7c51078)      │
│  Value: sessionId (如: feishu_oc_xxx_1773217571561)          │
│                                                              │
│  生命周期:                                                   │
│  - 启动时: warmupCache() 从 DB 加载所有映射                   │
│  - 运行时: 读写操作优先访问内存                                │
│  - 失效时: 同时删除内存缓存和 DB 记录                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ 同步
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    SQLite 持久化层                            │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │           feishu_mappings 表                         │    │
│  ├─────────────────────────────────────────────────────┤    │
│  │  chat_id (TEXT PK)  │  session_id (TEXT)            │    │
│  │  created_at (INT)   │  updated_at (INT)             │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  索引: idx_feishu_session (on session_id)                   │
│                                                              │
│  操作函数:                                                   │
│  - getMapping(chatId)        ← SELECT 查询                  │
│  - setMapping(chatId, sid)   ← INSERT/UPDATE                │
│  - deleteMapping(chatId)     ← DELETE                       │
│  - listMappings()            ← 全量查询（缓存预热）           │
│  - getChatBySession(sid)     ← 反向查找                     │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │             sessions 表                              │    │
│  ├─────────────────────────────────────────────────────┤    │
│  │  id (TEXT PK)       │  name (TEXT)                  │    │
│  │  system_prompt      │  model (TEXT)                 │    │
│  │  created_at         │  updated_at                   │    │
│  │  is_active (INT)    │                               │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
Session ID 格式演进
第一次对话 (chatId = oc_xxx):
└── sessionId = "feishu_oc_xxx_1773217571561"  (带时间戳)
用户执行 /new 后:
├── 旧 session "feishu_oc_xxx_1773217571561" 被删除
└── 新 session "feishu_oc_xxx_1773218000000" 被创建
    └── 映射更新: chatId → 新 sessionId
用户再次执行 /new 后:
├── 旧 session "feishu_oc_xxx_1773218000000" 被删除
└── 新 session "feishu_oc_xxx_1773219000000" 被创建
    └── 映射更新: chatId → 最新 sessionId
关键代码路径
获取/创建 Session (gateway.ts:482-528):
private getOrCreateSession(message: FeishuMessage): Session {
    const chatId = message.chatId;
    // 1. 内存缓存检查
    const cachedSessionId = this.sessionCache.get(chatId);
    if (cachedSessionId) {
        const session = getSession(cachedSessionId);
        if (session) return session;
        // 缓存失效，清理
        this.sessionCache.delete(chatId);
        deleteMapping(chatId);
    }
    // 2. DB 映射检查
    const mapping = getMapping(chatId);
    if (mapping) {
        const session = getSession(mapping.sessionId);
        if (session) {
            this.sessionCache.set(chatId, session.id);  // 回填缓存
            return session;
        }
        deleteMapping(chatId);  // 映射失效
    }
    // 3. 创建新 Session
    const sessionId = `feishu_${chatId}_${Date.now()}`;
    const session = createSession(sessionId, ...);
    // 4. 保存映射（内存 + DB）
    this.sessionCache.set(chatId, sessionId);
    setMapping(chatId, sessionId);
    return session;
}
```