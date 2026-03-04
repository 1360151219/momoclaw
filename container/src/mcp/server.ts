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
        'fetch_zhihu_article',
        '抓取知乎专栏文章的内容。支持 zhuanlan.zhihu.com 域名。',
        {
          url: z
            .string()
            .describe(
              '知乎文章的完整 URL，例如 https://zhuanlan.zhihu.com/p/12345678',
            ),
        },
        async ({ url }) => {
          const article = await fetcher.fetchZhihuArticle(url);
          return {
            content: [{ type: 'text' as const, text: formatArticle(article) }],
          };
        },
      ),
      tool(
        'fetch_wechat_article',
        '抓取微信公众号文章的内容。支持 mp.weixin.qq.com 域名。',
        {
          url: z.string().describe('微信公众号文章的完整 URL'),
        },
        async ({ url }) => {
          const article = await fetcher.fetchWechatArticle(url);
          return {
            content: [{ type: 'text' as const, text: formatArticle(article) }],
          };
        },
      ),
      tool(
        'fetch_generic_article',
        '通用文章抓取工具，尝试提取任意网页的正文内容。支持掘金、CSDN、博客园等平台。',
        {
          url: z.string().describe('文章的完整 URL'),
          selector: z
            .string()
            .optional()
            .describe('可选的 CSS 选择器，用于指定正文容器'),
        },
        async ({ url, selector }) => {
          const article = await fetcher.fetchGenericArticle(url, selector);
          return {
            content: [{ type: 'text' as const, text: formatArticle(article) }],
          };
        },
      ),
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
        '创建定时任务，支持 cron/interval/once 三种类型。根据 scheduleType 选择合适的 scheduleValue 格式，确保时间格式正确\n'
        + '根据 scheduleType 不同格式要求如下：' +
        '【cron】标准 cron 表达式，如 "0 9 * * *"（每天9点）、"*/5 * * * *"（每5分钟）；' +
        '【interval】间隔秒数，如 "3600"（1小时）、"60"（1分钟）；' +
        '【once】时间戳形式，如 "1709542800000"（2024年3月4日9点），注意：⚠️ 禁止使用相对时间（如30s、1h、tomorrow）',
        {
          sessionId: z.string().describe('关联的会话ID'),
          prompt: z.string().describe('定时执行的提示词'),
          scheduleType: z
            .enum(['cron', 'interval', 'once'])
            .describe('调度类型：cron表达式/间隔秒数/一次性执行'),
          scheduleValue: z
            .string()
            .describe(
              '调度参数，根据 scheduleType 不同格式要求如下：' +
              '【cron】标准 cron 表达式，如 "0 9 * * *"（每天9点）、"*/5 * * * *"（每5分钟）；' +
              '【interval】间隔秒数，如 "3600"（1小时）、"60"（1分钟）；' +
              '【once】时间戳形式，如 "1709542800000"（2024年3月4日9点），注意：⚠️ 禁止使用相对时间（如30s、1h、tomorrow）'
            ),
        },
        async ({ sessionId, prompt, scheduleType, scheduleValue }) => {
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
