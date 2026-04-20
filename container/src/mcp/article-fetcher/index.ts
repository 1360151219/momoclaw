import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { ArticleFetcher } from './fetcher.js';

const fetcher = new ArticleFetcher();

export function createArticleFetcherMcpServer() {
  return createSdkMcpServer({
    name: 'momoclaw-mcp',
    version: '1.0.0',
    tools: [
      tool(
        'summarize_article',
        '获取文章的纯文本正文。该工具只负责提取文章长文本，不进行摘要生成，摘要分析由大模型完成。',
        {
          url: z.string().describe('文章的完整 URL'),
          platform: z
            .enum(['zhihu', 'wechat', 'auto'])
            .optional()
            .describe('平台类型：zhihu、wechat 或 auto（自动检测）'),
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
    ],
  });
}
