import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { ArticleFetcher } from './fetcher.js';
import { SearchService } from './search.js';

const fetcher = new ArticleFetcher();
const searchService = new SearchService({
  timeout: 25_000,
  maxRetries: 3,
  region: 'cn-zh',
});

/**
 * 创建 article-fetcher 对应的 MCP Server。
 * 这里同时暴露文章抓取和网页搜索两个工具，方便上层 Agent 先搜索、再抓正文。
 */
export function createArticleFetcherMcpServer() {
  return createSdkMcpServer({
    name: 'momoclaw-mcp',
    version: '1.0.0',
    tools: [
      tool(
        'WebFetch',
        [
          '获取网页或文章链接的正文内容，适合在已经拿到明确 URL 后主动调用。',
          '当用户要求你总结文章、提取全文、阅读网页、分析长文、抓取公众号/知乎/通用网页正文时，优先使用这个工具。',
          '这个工具的职责是“读取正文内容”，不是搜索网页；如果你还没有 URL，应该先调用 WebSearch 找到候选链接，再调用本工具。',
          '支持 `wechat`、`zhihu` 和 `auto` 三种平台模式；拿不准时优先使用 `auto` 自动检测。',
          '返回结果是结构化文章数据，包含标题、作者、正文、来源链接、发布时间等字段，后续摘要、分析、问答由大模型继续完成。',
        ].join('\n'),
        {
          url: z
            .string()
            .describe(
              '要抓取正文的完整网页 URL。只有在你已经明确拿到链接时才传入。',
            ),
          platform: z
            .enum(['zhihu', 'wechat', 'auto'])
            .optional()
            .describe(
              '平台类型：zhihu、wechat 或 auto。若不确定网页来源，请优先使用 auto。',
            ),
        },
        async ({ url, platform = 'auto' }) => {
          const article = await fetcher.fetchArticle(url, platform);
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(article, null, 2) },
            ],
          };
        },
      ),
      tool(
        'WebSearch',
        [
          '当用户要求你搜索资讯、查新闻、找网页、找图片、找视频、寻找某个主题相关文章或候选链接，或者你需要查询某些信息来完成任务时，优先使用这个工具。',
          '这个工具只负责“找结果”，不会返回文章全文；如果你需要进一步阅读某条结果的正文，请拿结果中的 URL 再调用 WebFetch。',
          '返回结果是结构化搜索列表，适合作为后续筛选链接、继续抓正文、做总结分析的前置步骤。',
        ].join('\n'),
        {
          query: z
            .string()
            .min(1)
            .describe(
              '搜索关键词或问题描述。尽量传入明确主题，便于拿到更准确的候选结果。',
            ),
        },
        async ({ query }) => {
          const result = await searchService.search(query);

          return {
            content: [
              { type: 'text' as const, text: JSON.stringify(result, null, 2) },
            ],
          };
        },
      ),
    ],
  });
}
