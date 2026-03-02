#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { ArticleFetcher } from './article-fetcher.js';

const fetcher = new ArticleFetcher();

// 定义可用的工具
const TOOLS: Tool[] = [
  {
    name: 'fetch_zhihu_article',
    description: '抓取知乎专栏文章的内容。支持 zhuanlan.zhihu.com 域名。',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '知乎文章的完整 URL，例如 https://zhuanlan.zhihu.com/p/12345678',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'fetch_wechat_article',
    description: '抓取微信公众号文章的内容。支持 mp.weixin.qq.com 域名。',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '微信公众号文章的完整 URL',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'fetch_generic_article',
    description: '通用文章抓取工具，尝试提取任意网页的正文内容。支持掘金、CSDN、博客园等平台。',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '文章的完整 URL',
        },
        selector: {
          type: 'string',
          description: '可选的 CSS 选择器，用于指定正文容器',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'summarize_article',
    description: '获取文章并返回结构化的摘要，包括标题、作者、关键要点等。',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '文章的完整 URL',
        },
        platform: {
          type: 'string',
          description: '平台类型：zhihu、wechat、juejin、csdn 或 auto（自动检测）',
          enum: ['zhihu', 'wechat', 'juejin', 'csdn', 'auto'],
        },
      },
      required: ['url'],
    },
  },
];

// 创建 MCP 服务器
const server = new Server(
  {
    name: 'article-fetcher-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 处理工具列表请求
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// 处理工具调用请求
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    switch (name) {
      case 'fetch_zhihu_article': {
        const { url } = args as { url: string };
        const article = await fetcher.fetchZhihuArticle(url);
        result = formatArticle(article);
        break;
      }

      case 'fetch_wechat_article': {
        const { url } = args as { url: string };
        const article = await fetcher.fetchWechatArticle(url);
        result = formatArticle(article);
        break;
      }

      case 'fetch_generic_article': {
        const { url, selector } = args as { url: string; selector?: string };
        const article = await fetcher.fetchGenericArticle(url, selector);
        result = formatArticle(article);
        break;
      }

      case 'summarize_article': {
        const { url, platform = 'auto' } = args as { url: string; platform?: string };
        const article = await fetcher.summarizeArticle(url, platform);
        result = JSON.stringify(article, null, 2);
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: result,
        },
      ],
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// 格式化文章为可读文本
function formatArticle(article: {
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

// 启动服务器
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Article Fetcher MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
