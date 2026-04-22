import type { Extractor, Article, FetchOptions } from './types.js';
import { articleCache } from './cache.js';
import { WechatExtractor } from './extractors/wechat.js';
import { ZhihuExtractor } from './extractors/zhihu.js';
import { GenericExtractor } from './extractors/generic.js';

export class ArticleFetcher {
  private extractors: Extractor[] = [
    new WechatExtractor(),
    new ZhihuExtractor(),
    new GenericExtractor(), // Generic 必须放在最后作为 Fallback
  ];

  /**
   * 核心抓取入口
   */
  async fetchArticle(url: string, platform: string = 'auto', options?: FetchOptions): Promise<Article> {
    // 1. 检查缓存
    const cacheKey = `${url}-${options?.offset || 0}-${options?.limit || 0}`;
    const cached = articleCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // 2. Fetch HTML
    const html = await this.downloadHtml(url);

    // 3. 选择 Extractor (Strategy Pattern)
    let extractor: Extractor | undefined;

    if (platform !== 'auto') {
      // 强制平台
      switch (platform) {
        case 'wechat':
          extractor = this.extractors.find((e) => e instanceof WechatExtractor);
          break;
        case 'zhihu':
          extractor = this.extractors.find((e) => e instanceof ZhihuExtractor);
          break;
      }
    }

    if (!extractor) {
      // 自动路由
      extractor = this.extractors.find((e) => e.match(url));
    }

    if (!extractor) {
      throw new Error(`No suitable extractor found for url: ${url}`);
    }

    // 4. 解析
    const article = await extractor.extract(url, html, options);

    // 5. 设置缓存
    articleCache.set(cacheKey, article);

    return article;
  }

  private async downloadHtml(url: string): Promise<string> {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.text();
    } catch (error: any) {
      throw new Error(`Failed to fetch URL ${url}: ${error.message}`);
    }
  }
}
