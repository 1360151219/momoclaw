import * as cheerio from 'cheerio';
import type { Extractor, Article, FetchOptions } from '../types.js';
import { cleanHtmlToText } from './utils.js';

export class ZhihuExtractor implements Extractor {
  match(url: string): boolean {
    return url.includes('zhihu.com');
  }

  async extract(url: string, html: string, options?: FetchOptions): Promise<Article> {
    const $ = cheerio.load(html);

    const title =
      $('h1.QuestionHeader-title').text().trim() ||
      $('h1.Post-Title').text().trim() ||
      $('title').text().trim().replace(' - 知乎', '') ||
      '未知标题';

    const author =
      $('.AuthorInfo-name').first().text().trim() ||
      $('meta[itemprop="name"]').first().attr('content');

    const publishTime = $('meta[itemprop="datePublished"]').first().attr('content');

    // 优先提取专栏文章或回答内容
    let contentHtml = $('.Post-RichTextContainer').html() || $('.RichContent-inner').first().html();

    // 如果找不到，直接回退到正文提取
    if (!contentHtml) {
      contentHtml = $('body').html() || '';
    }

    let content = cleanHtmlToText(contentHtml);

    // 分页逻辑
    let hasMore = false;
    let nextOffset = undefined;
    if (options?.offset !== undefined && options?.limit !== undefined) {
      const contentLength = content.length;
      const end = options.offset + options.limit;
      if (contentLength > end) {
        hasMore = true;
        nextOffset = end;
      }
      content = content.slice(options.offset, end);
    }

    return {
      title,
      author,
      content,
      url,
      publishTime,
      platform: 'zhihu',
      hasMore,
      nextOffset,
    };
  }
}
