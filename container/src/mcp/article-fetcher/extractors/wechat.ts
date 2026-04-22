import * as cheerio from 'cheerio';
import type { Extractor, Article, FetchOptions } from '../types.js';
import { cleanHtmlToText } from './utils.js';

export class WechatExtractor implements Extractor {
  match(url: string): boolean {
    return url.includes('mp.weixin.qq.com');
  }

  async extract(url: string, html: string, options?: FetchOptions): Promise<Article> {
    const $ = cheerio.load(html);

    // 微信公众号经常把核心数据放在 script 变量里，或者直接在 meta property 中
    const title =
      $('meta[property="og:title"]').attr('content') ||
      $('#activity-name').text().trim() ||
      $('title').text().trim() ||
      '未知标题';

    const author =
      $('meta[property="og:article:author"]').attr('content') ||
      $('#js_name').text().trim();

    const publishTime = $('#publish_time').text().trim();

    // 提取正文
    let contentHtml = $('#js_content').html();
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
      platform: 'wechat',
      hasMore,
      nextOffset,
    };
  }
}
