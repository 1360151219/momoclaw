#!/usr/bin/env node

/**
 * 文章抓取 CLI 工具
 * 用法: node dist/fetch-article-cli.js <url> [--format=json|markdown|text]
 */

import { ArticleFetcher } from './article-fetcher.js';

const fetcher = new ArticleFetcher();

function showHelp() {
  console.log(`
文章抓取工具 - 支持知乎、微信公众号、掘金、CSDN、博客园等平台

用法:
  node dist/fetch-article-cli.js <url> [选项]

选项:
  --format=<type>    输出格式: text(默认), json, markdown
  --summary          输出摘要而非全文
  --help             显示帮助

示例:
  node dist/fetch-article-cli.js https://zhuanlan.zhihu.com/p/12345678
  node dist/fetch-article-cli.js https://mp.weixin.qq.com/s/xxx --format=json
  node dist/fetch-article-cli.js https://juejin.cn/post/xxx --summary
`);
}

function formatAsMarkdown(article: {
  title: string;
  author?: string;
  content: string;
  url: string;
  publishTime?: string;
  platform: string;
}): string {
  const parts = [
    `# ${article.title}`,
    '',
    `- **来源**: ${article.platform}`,
    `- **URL**: ${article.url}`,
    article.author ? `- **作者**: ${article.author}` : '',
    article.publishTime ? `- **发布时间**: ${article.publishTime}` : '',
    '',
    '---',
    '',
    article.content,
  ];
  return parts.filter(Boolean).join('\n');
}

function formatAsText(article: {
  title: string;
  author?: string;
  content: string;
  url: string;
  publishTime?: string;
  platform: string;
}): string {
  const parts = [
    `标题: ${article.title}`,
    `平台: ${article.platform}`,
    `URL: ${article.url}`,
    article.author ? `作者: ${article.author}` : '',
    article.publishTime ? `发布时间: ${article.publishTime}` : '',
    '',
    '==================',
    '',
    article.content,
  ];
  return parts.filter(Boolean).join('\n');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    showHelp();
    process.exit(0);
  }

  const url = args.find((arg) => !arg.startsWith('--'));
  if (!url) {
    console.error('错误: 请提供 URL');
    showHelp();
    process.exit(1);
  }

  const format =
    (args.find((arg) => arg.startsWith('--format='))?.split('=')[1] as
      | 'text'
      | 'json'
      | 'markdown') || 'text';
  const useSummary = args.includes('--summary');

  try {
    console.error(`正在抓取: ${url}`);
    console.error(`平台: ${fetcher.detectPlatform(url)}`);
    console.error('---');

    if (useSummary) {
      const summary = await fetcher.summarizeArticle(url, 'auto');

      if (format === 'json') {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(`# ${summary.title}`);
        console.log();
        console.log(`**平台**: ${summary.platform}`);
        if (summary.author) console.log(`**作者**: ${summary.author}`);
        if (summary.publishTime)
          console.log(`**发布时间**: ${summary.publishTime}`);
        console.log(`**字数**: ${summary.wordCount}`);
        console.log();
        console.log('## 摘要');
        console.log(summary.summary);
        console.log();
        console.log('## 关键要点');
        summary.keyPoints.forEach((point, i) => {
          console.log(`${i + 1}. ${point}`);
        });
        console.log();
        console.log('## 正文');
        console.log(summary.content);
      }
    } else {
      const platform = fetcher.detectPlatform(url);
      let article;

      switch (platform) {
        case 'zhihu':
          article = await fetcher.fetchZhihuArticle(url);
          break;
        case 'wechat':
          article = await fetcher.fetchWechatArticle(url);
          break;
        default:
          article = await fetcher.fetchGenericArticle(url);
      }

      if (format === 'json') {
        console.log(JSON.stringify(article, null, 2));
      } else if (format === 'markdown') {
        console.log(formatAsMarkdown(article));
      } else {
        console.log(formatAsText(article));
      }
    }
  } catch (error: any) {
    console.error(`错误: ${error.message}`);
    process.exit(1);
  }
}

main();
