import * as cheerio from 'cheerio';
import type { Extractor, Article, FetchOptions } from '../types.js';
import { cleanHtmlToText } from './utils.js';

export class GenericExtractor implements Extractor {
  match(_url: string): boolean {
    return true; // 永远匹配作为后备
  }

  async extract(url: string, html: string, options?: FetchOptions): Promise<Article> {
    const $ = cheerio.load(html);

    const title =
      $('meta[property="og:title"]').attr('content') ||
      $('title').text().trim() ||
      $('h1').first().text().trim() ||
      '未知标题';

    const author =
      $('meta[name="author"]').attr('content') ||
      $('meta[property="article:author"]').attr('content') ||
      $('.author').text().trim();

    const publishTime =
      $('meta[name="published_time"]').attr('content') ||
      $('meta[property="article:published_time"]').attr('content') ||
      $('.date').text().trim();

    // 简单启发式寻找正文块
    let contentHtml = '';
    const possibleSelectors = ['article', '.article', '.content', '.post', 'main'];
    for (const selector of possibleSelectors) {
      if ($(selector).length > 0) {
        contentHtml = $(selector).html() || '';
        break;
      }
    }

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
      platform: 'generic',
      hasMore,
      nextOffset,
    };
  }
}
