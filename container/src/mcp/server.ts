/**
 * MCP (Model Context Protocol) 服务器模块
 * 提供文章抓取和定时任务相关的 MCP 工具
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { ArticleFetcher } from '../article-fetcher.js';

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
    name: 'miniclaw-mcp',
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
      // 定时任务相关工具
      tool(
        'schedule_task',
        `创建定时任务。请根据 scheduleType 严格遵守以下 scheduleValue 格式要求：
1. type="cron": 表示每隔一段时间需要执行的表达式，使用标准 Cron 表达式 (分 时 日 月 周)。
   - 示例: "0 9 * * *" (每天09:00), "*/5 * * * *" (每5分钟)
2. type="once": 表示一次性执行，必须使用 13 位毫秒级时间戳 (Unix Timestamp)。
   - 示例: "1709542800000"
   - ⚠️ 严禁使用 "2024-03-04" 或 "tomorrow" 等自然语言或相对时间。`,
        {
          sessionId: z.string().optional().describe('关联的会话ID（可以不传）'),
          prompt: z.string().describe('定时执行的提示词'),
          scheduleType: z
            .enum(['cron', 'once'])
            .describe('调度类型：cron表达式/一次性执行'),
          scheduleValue: z.string().describe(
            `调度参数值。必须严格符合 scheduleType 对应的格式：
- cron: "0 9 * * *"
- once: "1709542800000" (13位时间戳，禁止使用自然语言)`,
          ),
        },
        async ({ sessionId = '', prompt, scheduleType, scheduleValue }) => {
          // 这些工具由 Host 层特殊处理，这里返回占位信息
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'queued',
                  type: 'cron_action',
                  action: {
                    type: 'create',
                    payload: { sessionId, prompt, scheduleType, scheduleValue },
                  },
                }),
              },
            ],
          };
        },
      ),
      tool(
        'list_scheduled_tasks',
        '列出指定会话的定时任务',
        {
          sessionId: z.string().describe('会话ID'),
        },
        async ({ sessionId }) => {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'queued',
                  type: 'cron_action',
                  action: { type: 'list', payload: { sessionId } },
                }),
              },
            ],
          };
        },
      ),
      tool(
        'pause_task',
        '暂停定时任务',
        {
          taskId: z.string().describe('任务ID'),
        },
        async ({ taskId }) => {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'queued',
                  type: 'cron_action',
                  action: { type: 'pause', payload: { taskId } },
                }),
              },
            ],
          };
        },
      ),
      tool(
        'resume_task',
        '恢复定时任务',
        {
          taskId: z.string().describe('任务ID'),
        },
        async ({ taskId }) => {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'queued',
                  type: 'cron_action',
                  action: { type: 'resume', payload: { taskId } },
                }),
              },
            ],
          };
        },
      ),
      tool(
        'delete_task',
        '删除定时任务',
        {
          taskId: z.string().describe('任务ID'),
        },
        async ({ taskId }) => {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'queued',
                  type: 'cron_action',
                  action: { type: 'delete', payload: { taskId } },
                }),
              },
            ],
          };
        },
      ),
      tool(
        'get_task_logs',
        '获取任务执行日志',
        {
          taskId: z.string().describe('任务ID'),
          limit: z
            .number()
            .optional()
            .default(10)
            .describe('返回的最大日志条数'),
        },
        async ({ taskId, limit }) => {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'queued',
                  type: 'cron_action',
                  action: { type: 'logs', payload: { taskId, limit } },
                }),
              },
            ],
          };
        },
      ),
    ],
  });
}
