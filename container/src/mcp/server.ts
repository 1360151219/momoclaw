/**
 * MCP (Model Context Protocol) 服务器模块
 * 提供文章抓取和定时任务相关的 MCP 工具
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { ArticleFetcher } from './article-fetcher.js';

const fetcher = new ArticleFetcher();

/**
 * 格式化文章为可读文本
 */
export function formatArticle(article: {
  title: string;
  author?: string;
  content: string;
  url: string;
  publishTime?: string;
}): string {
  const parts = [
    `标题：${article.title}`,
    article.author ? `作者：${article.author}` : '',
    article.publishTime ? `发布时间：${article.publishTime}` : '',
    `URL：${article.url}`,
    '',
    '--- 正文 ---',
    '',
    article.content,
  ];
  return parts.filter(Boolean).join('\n');
}

/**
 * 创建 SDK 集成的 MCP 服务器
 * 用于直接在 agent 进程内运行
 */
export function createArticleFetcherMcpServer() {
  return createSdkMcpServer({
    name: 'momoclaw-mcp',
    version: '1.0.0',
    tools: [
      tool(
        'summarize_article',
        '获取文章并返回结构化的摘要，包括标题、作者、关键要点等。',
        {
          url: z.string().describe('文章的完整 URL'),
          platform: z
            .enum(['zhihu', 'wechat', 'juejin', 'csdn', 'auto'])
            .optional()
            .describe(
              '平台类型：zhihu、wechat、juejin、csdn 或 auto（自动检测）',
            ),
        },
        async ({ url, platform = 'auto' }) => {
          const article = await fetcher.summarizeArticle(url, platform);
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
