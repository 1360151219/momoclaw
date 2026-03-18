/**
 * 文章抓取工具 - 支持国内主流平台
 * 使用原生 fetch 和正则表达式提取文章内容，无需外部依赖
 */

export interface Article {
  title: string;
  author?: string;
  content: string;
  url: string;
  publishTime?: string;
  platform: string;
}

export interface FetchOptions {
  offset?: number;
  limit?: number;
}

/**
 * 缓存条目结构
 */
interface CacheEntry {
  content: string;
  timestamp: number;
  totalLength: number;
  platform: string;
  title?: string;
}

/**
 * 缓存配置
 */
const CACHE_TTL = 15 * 60 * 1000; // 15 分钟
const MAX_CACHE_SIZE = 100; // 最大缓存条目数

export interface FetchResult {
  content: string;
  totalLength: number;
  hasMore: boolean;
  nextOffset?: number;
}

export interface ArticleSummary {
  title: string;
  author?: string;
  url: string;
  publishTime?: string;
  platform: string;
  summary: string;
  keyPoints: string[];
  wordCount: number;
  content: string;
}

export class ArticleFetcher {
  private readonly userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  private readonly maxBodySize = 2 * 1024 * 1024; // 2MB limit

  // LRU 缓存：url -> CacheEntry
  private cache = new Map<string, CacheEntry>();
  private accessOrder: string[] = []; // 用于 LRU 淘汰

  /**
   * 从缓存获取，自动处理过期和 LRU 淘汰
   */
  private getFromCache(url: string): CacheEntry | null {
    const entry = this.cache.get(url);

    if (!entry) {
      return null;
    }

    // 检查是否过期
    if (Date.now() - entry.timestamp > CACHE_TTL) {
      this.deleteFromCache(url);
      return null;
    }

    // 更新访问顺序（LRU）
    this.updateAccessOrder(url);

    return entry;
  }

  /**
   * 写入缓存，自动执行 LRU 淘汰
   */
  private setCache(url: string, entry: Omit<CacheEntry, 'timestamp'>): void {
    // 如果已满且不是更新已有条目，淘汰最旧的
    if (this.cache.size >= MAX_CACHE_SIZE && !this.cache.has(url)) {
      this.evictLRU();
    }

    this.cache.set(url, { ...entry, timestamp: Date.now() });
    this.updateAccessOrder(url);
  }

  /**
   * 从缓存删除
   */
  private deleteFromCache(url: string): void {
    this.cache.delete(url);
    this.accessOrder = this.accessOrder.filter(u => u !== url);
  }

  /**
   * 更新访问顺序（LRU）
   */
  private updateAccessOrder(url: string): void {
    this.accessOrder = this.accessOrder.filter(u => u !== url);
    this.accessOrder.push(url);
  }

  /**
   * 淘汰最久未访问的条目
   */
  private evictLRU(): void {
    if (this.accessOrder.length === 0) return;

    const oldest = this.accessOrder.shift();
    if (oldest) {
      this.cache.delete(oldest);
    }
  }

  /**
   * 清除所有缓存
   */
  clearCache(): void {
    this.cache.clear();
    this.accessOrder = [];
  }

  /**
   * 获取缓存统计信息
   */
  getCacheStats(): { size: number; maxSize: number; ttl: number; keys: string[] } {
    return {
      size: this.cache.size,
      maxSize: MAX_CACHE_SIZE,
      ttl: CACHE_TTL,
      keys: Array.from(this.cache.keys()),
    };
  }

  /**
   * SSRF 安全检查 - 防止访问内网地址和云元数据服务
   */
  private isSafeUrl(url: string): { safe: boolean; reason?: string } {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();

      // 检查 localhost
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
        return { safe: false, reason: 'Localhost access is not allowed' };
      }

      // 检查 IPv4 内网地址
      const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
      if (ipv4Regex.test(hostname)) {
        const parts = hostname.split('.').map(Number);
        // 127.0.0.0/8
        if (parts[0] === 127) {
          return { safe: false, reason: 'Loopback address is not allowed' };
        }
        // 10.0.0.0/8
        if (parts[0] === 10) {
          return { safe: false, reason: 'Private network (10.x.x.x) is not allowed' };
        }
        // 172.16.0.0/12
        if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
          return { safe: false, reason: 'Private network (172.16-31.x.x) is not allowed' };
        }
        // 192.168.0.0/16
        if (parts[0] === 192 && parts[1] === 168) {
          return { safe: false, reason: 'Private network (192.168.x.x) is not allowed' };
        }
        // 169.254.0.0/16 (Link-local)
        if (parts[0] === 169 && parts[1] === 254) {
          return { safe: false, reason: 'Link-local address (169.254.x.x) is not allowed' };
        }
        // 0.0.0.0/8
        if (parts[0] === 0) {
          return { safe: false, reason: 'Current network (0.x.x.x) is not allowed' };
        }
      }

      // 检查云元数据服务地址
      const blockedHosts = [
        '169.254.169.254', // AWS, GCP, Azure metadata
        'metadata.google.internal',
        'metadata.google.internal.',
        'instance-data', // AWS
        'alibaba.dns', // Alibaba Cloud
        'metadata.tencentyun.com', // Tencent Cloud
      ];
      if (blockedHosts.some(h => hostname === h || hostname.endsWith('.' + h))) {
        return { safe: false, reason: 'Cloud metadata service is not allowed' };
      }

      // 检查常见内网域名
      const internalPatterns = [
        /^metadata\./,
        /^internal\./,
        /^intranet\./,
        /^private\./,
        /^.*\.local$/,
        /^.*\.internal$/,
        /^.*\.lan$/,
        /^.*\.docker$/,
        /^.*\.svc$/,
        /^.*\.cluster\.local$/,
      ];
      if (internalPatterns.some(p => p.test(hostname))) {
        return { safe: false, reason: 'Internal domain pattern is not allowed' };
      }

      return { safe: true };
    } catch {
      return { safe: false, reason: 'Invalid URL format' };
    }
  }

  /**
   * 检测 URL 所属平台
   */
  detectPlatform(url: string): string {
    if (url.includes('zhuanlan.zhihu.com') || url.includes('zhihu.com')) {
      return 'zhihu';
    }
    if (url.includes('mp.weixin.qq.com')) {
      return 'wechat';
    }
    if (url.includes('juejin.cn')) {
      return 'juejin';
    }
    if (url.includes('blog.csdn.net') || url.includes('csdn.net')) {
      return 'csdn';
    }
    if (url.includes('cnblogs.com')) {
      return 'cnblogs';
    }
    if (url.includes('bilibili.com/read')) {
      return 'bilibili';
    }
    if (url.includes('oschina.net')) {
      return 'oschina';
    }
    if (url.includes('segmentfault.com')) {
      return 'segmentfault';
    }
    return 'generic';
  }

  /**
   * 发送 HTTP 请求获取页面内容（带 SSRF 防护、大小限制和缓存）
   */
  async fetchPageSafe(url: string, options?: FetchOptions): Promise<FetchResult> {
    // SSRF 检查
    const safety = this.isSafeUrl(url);
    if (!safety.safe) {
      throw new Error(`SSRF Protection: ${safety.reason}`);
    }

    // 检查缓存（只有在不分页时才使用缓存）
    const offset = options?.offset ?? 0;
    const limit = options?.limit;
    const shouldUseCache = offset === 0 && !limit;

    if (shouldUseCache) {
      const cached = this.getFromCache(url);
      if (cached) {
        return {
          content: cached.content,
          totalLength: cached.totalLength,
          hasMore: false,
        };
      }
    }

    const platform = this.detectPlatform(url);

    // 平台特定的 headers
    const platformHeaders: Record<string, Record<string, string>> = {
      zhihu: {
        Referer: 'https://www.zhihu.com/',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
      },
      wechat: {
        Referer: 'https://mp.weixin.qq.com/',
      },
      juejin: {
        Referer: 'https://juejin.cn/',
      },
    };

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      ...(platformHeaders[platform] || {}),
    };

    const response = await fetch(url, {
      headers,
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // 检查 Content-Length
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > this.maxBodySize) {
      throw new Error(`Response body too large: ${contentLength} bytes (max: ${this.maxBodySize})`);
    }

    // 读取响应体并检查大小
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > this.maxBodySize) {
      throw new Error(`Response body too large: ${buffer.byteLength} bytes (max: ${this.maxBodySize})`);
    }

    const text = new TextDecoder('utf-8').decode(buffer);
    const totalLength = text.length;

    // 分页处理
    const contentOffset = options?.offset ?? 0;
    const contentLimit = options?.limit ?? totalLength;

    const content = text.slice(contentOffset, contentOffset + contentLimit);
    const hasMore = contentOffset + contentLimit < totalLength;
    const nextOffset = hasMore ? contentOffset + contentLimit : undefined;

    // 写入缓存（只有完整内容才缓存）
    if (shouldUseCache) {
      this.setCache(url, {
        content: text,
        totalLength,
        platform,
      });
    }

    return {
      content,
      totalLength,
      hasMore,
      nextOffset,
    };
  }

  /**
   * 发送 HTTP 请求获取页面内容（向后兼容）
   */
  private async fetchPage(url: string): Promise<string> {
    const result = await this.fetchPageSafe(url);
    return result.content;
  }

  /**
   * 从 HTML 中提取标题
   */
  private extractTitle(html: string): string {
    // 尝试多种标题选择方式
    const patterns = [
      /<h1[^>]*class=["'][^"']*title[^"']*["'][^>]*>([^<]+)<\/h1>/i,
      /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"]+)["']/i,
      /<title>([^<]+)<\/title>/i,
      /<h1[^>]*>([^<]+)<\/h1>/i,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        return this.cleanText(match[1]);
      }
    }

    return '未获取到标题';
  }

  /**
   * 清理 HTML 实体和多余空白
   */
  private cleanText(text: string): string {
    if (!text) return '';
    return (
      text
        // HTML 实体解码
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&hellip;/g, '…')
        .replace(/&mdash;/g, '—')
        .replace(/&ndash;/g, '–')
        // 多余空白
        .replace(/\s+/g, ' ')
        .trim()
    );
  }

  /**
   * 从 HTML 中移除 script、style 等标签（基础清理）
   */
  private stripTags(html: string): string {
    return (
      html
        // 移除 script 和 style
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
        .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
        // 将常见块级标签转换为换行
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/h[1-6]>/gi, '\n\n')
        .replace(/<li>/gi, '• ')
        .replace(/<\/li>/gi, '\n')
        // 移除剩余标签
        .replace(/<[^>]+>/g, '')
        // 解码 HTML 实体
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&hellip;/g, '…')
        .replace(/&mdash;/g, '—')
        .replace(/&ndash;/g, '–')
        // 清理多余空白
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    );
  }

  /**
   * 多层级内容提取器
   * 优先级：1. 平台特定选择器 2. 文本密度算法 3. 基础 HTML 清理
   */
  private extractContentWithFallback(
    html: string,
    platform: string,
    customSelector?: string
  ): { content: string; method: string } {
    // 层级 1: 平台特定选择器
    if (customSelector) {
      const regex = new RegExp(
        `<${customSelector}[^>]*>([\\s\\S]*?)<\\/${customSelector}>`,
        'i'
      );
      const match = html.match(regex);
      if (match) {
        return { content: this.stripTags(match[1]), method: 'custom-selector' };
      }
    }

    // 层级 2: 平台特定模式
    const platformContent = this.tryPlatformSpecific(html, platform);
    if (platformContent) {
      return { content: platformContent, method: `platform-${platform}` };
    }

    // 层级 3: 智能文本密度算法
    const densityContent = this.extractMainContent(html);
    if (densityContent && densityContent.length > 500) {
      return { content: densityContent, method: 'text-density' };
    }

    // 层级 4: 基础 HTML 清理（后备）
    return {
      content: this.stripTags(html).slice(0, 10000),
      method: 'basic-cleanup',
    };
  }

  /**
   * 尝试平台特定的内容提取
   */
  private tryPlatformSpecific(html: string, platform: string): string | null {
    const patterns: Record<string, RegExp[]> = {
      juejin: [
        /<div[^>]*class=["'][^"']*article-content[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
        /<article[^>]*class=["'][^"']*article[^"']*["'][^>]*>([\s\S]*?)<\/article>/i,
      ],
      csdn: [
        /<div[^>]*id=["']content_views["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
        /<div[^>]*class=["'][^"']*blog-content-box[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      ],
      cnblogs: [
        /<div[^>]*id=["']cnblogs_post_body["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
      ],
      bilibili: [
        /<div[^>]*id=["']read-article-holder["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
      ],
      oschina: [
        /<div[^>]*class=["'][^"']*article-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      ],
      segmentfault: [
        /<div[^>]*class=["'][^"']*article-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      ],
    };

    const platformPatterns = patterns[platform];
    if (platformPatterns) {
      for (const pattern of platformPatterns) {
        const match = html.match(pattern);
        if (match) {
          return this.stripTags(match[1]);
        }
      }
    }

    return null;
  }

  /**
   * 提取知乎文章（支持分页）
   */
  async fetchZhihuArticle(
    url: string,
    options?: FetchOptions
  ): Promise<Article & { hasMore?: boolean; nextOffset?: number }> {
    // 获取完整内容用于提取元数据
    const fullResult = await this.fetchPageSafe(url);
    const fullHtml = fullResult.content;

    // 提取标题
    const title = this.extractTitle(fullHtml);

    // 提取作者
    let author = '';
    const authorMatch = fullHtml.match(
      /<meta[^>]*name=["']author["'][^>]*content=["']([^"]+)["']/i
    );
    if (authorMatch) {
      author = this.cleanText(authorMatch[1]);
    } else {
      const authorMatch2 = fullHtml.match(
        /<a[^>]*class=["'][^"']*author[^"']*["'][^>]*>([^<]+)<\/a>/i
      );
      if (authorMatch2) {
        author = this.cleanText(authorMatch2[1]);
      }
    }

    // 提取发布时间
    let publishTime = '';
    const timeMatch = fullHtml.match(
      /<meta[^>]*itemprop=["']datePublished["'][^>]*content=["']([^"]+)["']/i
    );
    if (timeMatch) {
      publishTime = timeMatch[1];
    }

    // 提取正文 - 使用多层级提取器
    let fullContent = '';
    const contentMatch = fullHtml.match(
      /<div[^>]*class=["'][^"']*RichText[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i
    );
    if (contentMatch) {
      fullContent = this.stripTags(contentMatch[1]);
    } else {
      // 备选方案
      const articleMatch = fullHtml.match(
        /<article[^>]*>([\s\S]*?)<\/article>/i
      );
      if (articleMatch) {
        fullContent = this.stripTags(articleMatch[1]);
      } else {
        fullContent = this.extractMainContent(fullHtml);
      }
    }

    // 分页处理
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? fullContent.length;
    const content = fullContent.slice(offset, offset + limit);
    const hasMore = offset + limit < fullContent.length;
    const nextOffset = hasMore ? offset + limit : undefined;

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

  /**
   * 提取微信公众号文章（支持分页）
   */
  async fetchWechatArticle(
    url: string,
    options?: FetchOptions
  ): Promise<Article & { hasMore?: boolean; nextOffset?: number }> {
    // 获取完整内容用于提取元数据
    const fullResult = await this.fetchPageSafe(url);
    const fullHtml = fullResult.content;

    // 提取标题
    const title = this.extractTitle(fullHtml);

    // 提取公众号名称
    let author = '';
    const authorMatch = fullHtml.match(
      /<a[^>]*id=["']js_name["'][^>]*>([^<]+)<\/a>/i
    );
    if (authorMatch) {
      author = this.cleanText(authorMatch[1]);
    } else {
      const authorMatch2 = fullHtml.match(
        /<span[^>]*class=["'][^"']*profile_nickname["'][^>]*>([^<]+)<\/span>/i
      );
      if (authorMatch2) {
        author = this.cleanText(authorMatch2[1]);
      }
    }

    // 提取发布时间
    let publishTime = '';
    const timeMatch = fullHtml.match(
      /<em[^>]*id=["']publish_time["'][^>]*>([^<]+)<\/em>/i
    );
    if (timeMatch) {
      publishTime = this.cleanText(timeMatch[1]);
    }

    // 提取正文
    let fullContent = '';
    const contentMatch = fullHtml.match(
      /<div[^>]*id=["']js_content["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i
    );
    if (contentMatch) {
      fullContent = this.stripTags(contentMatch[1]);
    } else {
      fullContent = this.extractMainContent(fullHtml);
    }

    // 分页处理
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? fullContent.length;
    const content = fullContent.slice(offset, offset + limit);
    const hasMore = offset + limit < fullContent.length;
    const nextOffset = hasMore ? offset + limit : undefined;

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

  /**
   * 通用文章抓取（增强版，支持分页和多层级提取器）
   */
  async fetchGenericArticle(
    url: string,
    selector?: string,
    options?: FetchOptions
  ): Promise<Article & { hasMore?: boolean; nextOffset?: number }> {
    const platform = this.detectPlatform(url);

    // 根据平台使用专门的抓取逻辑
    if (platform === 'zhihu') {
      return this.fetchZhihuArticle(url, options);
    }
    if (platform === 'wechat') {
      return this.fetchWechatArticle(url, options);
    }

    // 使用新的安全抓取方法
    const fetchResult = await this.fetchPageSafe(url, options);
    const html = fetchResult.content;
    const title = this.extractTitle(html);

    // 使用多层级提取器
    const { content } = this.extractContentWithFallback(html, platform, selector);

    return {
      title,
      content,
      url,
      platform,
      hasMore: fetchResult.hasMore,
      nextOffset: fetchResult.nextOffset,
    };
  }

  /**
   * 根据平台使用特定选择器（已弃用，使用 extractContentWithFallback）
   * @deprecated 使用 tryPlatformSpecific 替代
   */
  private async extractByPlatform(
    html: string,
    platform: string
  ): Promise<string> {
    return this.tryPlatformSpecific(html, platform) || '';
  }

  /**
   * 智能提取正文内容（基于文本密度算法）
   */
  private extractMainContent(html: string): string {
    // 移除 script 和 style
    const cleanHtml = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');

    // 提取所有 div 和 article 标签
    const divRegex =
      /<(div|article|section)[^>]*>([\s\S]*?)<\/\1>/gi;
    let bestContent = '';
    let bestScore = 0;

    let match;
    while ((match = divRegex.exec(cleanHtml)) !== null) {
      const text = this.stripTags(match[2]);
      const score = this.calculateContentScore(text);

      if (score > bestScore && text.length > 200) {
        bestScore = score;
        bestContent = text;
      }
    }

    return bestContent || this.stripTags(cleanHtml).slice(0, 5000);
  }

  /**
   * 计算文本的内容分数
   */
  private calculateContentScore(text: string): number {
    const cleanText = text.trim();
    if (cleanText.length < 100) return 0;

    // 计算文本密度（中文字符比例）
    const chineseChars = (cleanText.match(/[\u4e00-\u9fa5]/g) || []).length;
    const totalChars = cleanText.length;
    const chineseRatio = chineseChars / totalChars;

    // 计算段落数量
    const paragraphs = cleanText.split(/\n\s*\n/).length;

    // 惩罚过多的链接文本
    const linkRatio =
      (cleanText.match(/https?:\/\//g) || []).length / totalChars;

    // 综合分数
    const score =
      chineseRatio * 100 + Math.log(paragraphs + 1) * 10 - linkRatio * 1000;

    return score;
  }

  /**
   * 获取文章摘要（支持分页）
   */
  async summarizeArticle(
    url: string,
    platform: string = 'auto',
    options?: FetchOptions
  ): Promise<ArticleSummary & { hasMore?: boolean; nextOffset?: number }> {
    const detectedPlatform = platform === 'auto' ? this.detectPlatform(url) : platform;

    let article: Article & { hasMore?: boolean; nextOffset?: number };
    switch (detectedPlatform) {
      case 'zhihu':
        article = await this.fetchZhihuArticle(url, options);
        break;
      case 'wechat':
        article = await this.fetchWechatArticle(url, options);
        break;
      default:
        article = await this.fetchGenericArticle(url, undefined, options);
    }

    // 生成摘要
    const summary = this.generateSummary(article.content);
    const keyPoints = this.extractKeyPoints(article.content);

    return {
      title: article.title,
      author: article.author,
      url: article.url,
      publishTime: article.publishTime,
      platform: article.platform,
      summary,
      keyPoints,
      wordCount: article.content.length,
      content: article.content,
      hasMore: article.hasMore,
      nextOffset: article.nextOffset,
    };
  }

  /**
   * 生成摘要（提取前几句关键句）
   */
  private generateSummary(content: string, maxLength: number = 300): string {
    // 按句子分割
    const sentences = content
      .replace(/([。！？.!?])\s*/g, '$1|')
      .split('|')
      .filter((s) => s.trim().length > 10);

    if (sentences.length === 0) {
      return content.slice(0, maxLength) + '...';
    }

    // 取前几句
    let summary = '';
    for (const sentence of sentences.slice(0, 3)) {
      if ((summary + sentence).length <= maxLength) {
        summary += sentence;
      } else {
        break;
      }
    }

    return summary || content.slice(0, maxLength) + '...';
  }

  /**
   * 提取关键要点
   */
  private extractKeyPoints(content: string): string[] {
    const points: string[] = [];

    // 查找列表项
    const listItems = content.match(/[•\-\d+\.][\s]+([^\n]+)/g);
    if (listItems) {
      points.push(...listItems.slice(0, 5).map((item) => item.trim()));
    }

    // 查找加粗或重点内容
    const important = content.match(/(?:重要的是|关键在于|总结一下|结论)[：:]?([^。]+。?)/g);
    if (important) {
      points.push(...important.slice(0, 3));
    }

    // 如果没有找到要点，提取每段的第一句
    if (points.length === 0) {
      const paragraphs = content
        .split(/\n\s*\n/)
        .filter((p) => p.trim().length > 50)
        .slice(0, 5);

      for (const para of paragraphs) {
        const firstSentence = para.split(/[。！？.!?]/)[0];
        if (firstSentence && firstSentence.length > 20) {
          points.push(firstSentence.trim() + '。');
        }
      }
    }

    return points.slice(0, 6);
  }
}
