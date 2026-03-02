# 文章抓取 MCP 服务

基于 MCP (Model Context Protocol) 的文章抓取工具，支持国内主流技术平台。

## 支持平台

| 平台 | 域名 | 状态 |
|------|------|------|
| 知乎专栏 | zhuanlan.zhihu.com | ✅ |
| 微信公众号 | mp.weixin.qq.com | ✅ |
| 掘金 | juejin.cn | ✅ |
| CSDN | blog.csdn.net | ✅ |
| 博客园 | cnblogs.com | ✅ |
| B站专栏 | bilibili.com/read | ✅ |
| 开源中国 | oschina.net | ✅ |
| SegmentFault | segmentfault.com | ✅ |
| 其他网站 | 通用 | ⚠️ (可能不完美) |

## 使用方式

### 1. CLI 命令行工具

```bash
# 进入 container 目录
cd container

# 基本用法 - 抓取并输出为文本
node dist/fetch-article-cli.js <URL>

# 输出为 JSON 格式
node dist/fetch-article-cli.js <URL> --format=json

# 输出为 Markdown 格式
node dist/fetch-article-cli.js <URL> --format=markdown

# 获取文章摘要
node dist/fetch-article-cli.js <URL> --summary

# 示例
node dist/fetch-article-cli.js https://zhuanlan.zhihu.com/p/14013394073
node dist/fetch-article-cli.js https://mp.weixin.qq.com/s/xxx --format=json --summary
```

### 2. MCP 服务器（供 Claude Code 使用）

在 `~/.claude/settings.json` 中添加 MCP 服务器配置：

```json
{
  "mcpServers": {
    "article-fetcher": {
      "command": "node",
      "args": ["X:/workspace/momoclaw/container/dist/mcp-server.js"],
      "env": {},
      "cwd": "X:/workspace/momoclaw/container"
    }
  }
}
```

添加后，在 Claude Code 中可以直接使用以下工具：

- `fetch_zhihu_article` - 抓取知乎文章
- `fetch_wechat_article` - 抓取微信公众号文章
- `fetch_generic_article` - 通用文章抓取
- `summarize_article` - 抓取并生成摘要

### 3. 编程方式使用

```typescript
import { ArticleFetcher } from './src/article-fetcher.js';

const fetcher = new ArticleFetcher();

// 抓取知乎文章
const article = await fetcher.fetchZhihuArticle('https://zhuanlan.zhihu.com/p/xxx');
console.log(article.title);
console.log(article.content);

// 自动检测平台并抓取
const article2 = await fetcher.fetchGenericArticle('https://juejin.cn/post/xxx');

// 获取文章摘要
const summary = await fetcher.summarizeArticle('https://...', 'auto');
console.log(summary.keyPoints);
```

## 工作原理

1. **页面抓取**：使用原生 `fetch` 发送 HTTP 请求，模拟浏览器 User-Agent
2. **内容提取**：使用正则表达式匹配各平台特定的 HTML 结构
3. **智能提取**：针对没有特定规则的平台，使用文本密度算法提取正文
4. **内容清洗**：移除 script/style 标签，转换 HTML 实体，格式化输出

## 注意事项

1. **反爬虫限制**：部分平台可能有访问频率限制，频繁抓取可能导致 IP 被暂时封禁
2. **登录要求**：某些需要登录才能查看的内容无法抓取
3. **动态内容**：纯 JavaScript 渲染的页面可能无法正确抓取
4. **版权尊重**：请遵守各平台的使用条款，不要用于商业用途或大量抓取

## 反爬虫限制说明

由于国内主流平台（知乎、微信公众号等）都有严格的反爬虫机制，本工具可能遇到以下问题：

### 常见问题

1. **403 Forbidden** - 服务器拒绝了请求
2. **需要验证码** - 触发反爬虫验证
3. **内容不完整** - 部分内容需要 JavaScript 渲染

### 解决方案

#### 方案 1: 使用 RSSHub 等第三方服务

将文章链接转换为 RSS 源，然后抓取 RSS 内容：

```javascript
// 知乎专栏 RSS
https://rsshub.app/zhihu/zhuanlan/专栏ID

// 微信公众号（通过第三方服务）
https://rsshub.app/wechat/mp/公众号ID
```

#### 方案 2: 浏览器扩展 + 剪贴板

1. 安装浏览器扩展（如简悦、沉浸式翻译）
2. 打开文章页面
3. 使用阅读模式
4. 复制内容粘贴到 Claude Code
5. 让 Claude 帮你总结

#### 方案 3: 使用 Playwright/Puppeteer（高级）

如果需要稳定抓取，可以使用无头浏览器：

```typescript
import { chromium } from 'playwright';

async function fetchWithBrowser(url: string) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url);
  const content = await page.content();
  await browser.close();
  return content;
}
```

#### 方案 4: 手动复制（最可靠）

对于重要的文章，建议：
1. 在浏览器中打开
2. 使用阅读模式插件净化页面
3. 复制正文内容
4. 在 Claude Code 中使用 `/paste` 或发送给 Claude

## 成功案例

以下是测试成功的平台：

```bash
# 博客园 - ✅ 成功
node dist/fetch-article-cli.js https://www.cnblogs.com/pinard/p/10930902.html

# 掘金 - ⚠️ 部分成功（可能需要有效的文章ID）
node dist/fetch-article-cli.js https://juejin.cn/post/6844904197593403406

# 知乎 - ❌ 403（需要浏览器模拟或登录）
node dist/fetch-article-cli.js https://zhuanlan.zhihu.com/p/14013394073
```

## 故障排查

### 抓取失败
- 检查 URL 是否可访问
- 某些文章可能需要登录才能查看
- 尝试使用 `--format=text` 查看原始错误信息

### 内容提取不完整
- 某些页面使用了特殊的 JavaScript 框架渲染
- 可以尝试指定 `--summary` 获取关键要点
- 对于通用网页，可能需要手动指定 CSS 选择器

### MCP 连接失败
- 确保 Node.js 版本 >= 18
- 检查 settings.json 中的路径是否正确
- 查看 Claude Code 的 MCP 日志

## 架构说明

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│  Claude Code    │────▶│  MCP Server      │────▶│  Article    │
│  (MCP Client)   │◀────│  (stdio)         │◀────│  Fetcher    │
└─────────────────┘     └──────────────────┘     └─────────────┘
                               │                          │
                               │                   fetch() │
                               │                          ▼
                               │                   ┌─────────────┐
                               └──────────────────▶│  Target     │
                                                   │  Website    │
                                                   └─────────────┘
```

## 相关文件

- `src/mcp-server.ts` - MCP 服务器实现
- `src/article-fetcher.ts` - 文章抓取核心逻辑
- `src/fetch-article-cli.ts` - 命令行工具
- `src/types.ts` - 类型定义
