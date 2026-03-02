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
   * 发送 HTTP 请求获取页面内容
   */
  private async fetchPage(url: string): Promise<string> {
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

    return response.text();
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
   * 从 HTML 中移除 script、style 等标签
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
   * 提取知乎文章
   */
  async fetchZhihuArticle(url: string): Promise<Article> {
    const html = await this.fetchPage(url);

    // 提取标题
    const title = this.extractTitle(html);

    // 提取作者
    let author = '';
    const authorMatch = html.match(
      /<meta[^>]*name=["']author["'][^>]*content=["']([^"]+)["']/i
    );
    if (authorMatch) {
      author = this.cleanText(authorMatch[1]);
    } else {
      const authorMatch2 = html.match(
        /<a[^>]*class=["'][^"']*author[^"']*["'][^>]*>([^<]+)<\/a>/i
      );
      if (authorMatch2) {
        author = this.cleanText(authorMatch2[1]);
      }
    }

    // 提取发布时间
    let publishTime = '';
    const timeMatch = html.match(
      /<meta[^>]*itemprop=["']datePublished["'][^>]*content=["']([^"]+)["']/i
    );
    if (timeMatch) {
      publishTime = timeMatch[1];
    }

    // 提取正文 - 知乎专栏文章
    let content = '';
    const contentMatch = html.match(
      /<div[^>]*class=["'][^"']*RichText[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i
    );
    if (contentMatch) {
      content = this.stripTags(contentMatch[1]);
    } else {
      // 备选方案
      const articleMatch = html.match(
        /<article[^>]*>([\s\S]*?)<\/article>/i
      );
      if (articleMatch) {
        content = this.stripTags(articleMatch[1]);
      } else {
        content = this.extractMainContent(html);
      }
    }

    return {
      title,
      author,
      content,
      url,
      publishTime,
      platform: 'zhihu',
    };
  }

  /**
   * 提取微信公众号文章
   */
  async fetchWechatArticle(url: string): Promise<Article> {
    const html = await this.fetchPage(url);

    // 提取标题
    const title = this.extractTitle(html);

    // 提取公众号名称
    let author = '';
    const authorMatch = html.match(
      /<a[^>]*id=["']js_name["'][^>]*>([^<]+)<\/a>/i
    );
    if (authorMatch) {
      author = this.cleanText(authorMatch[1]);
    } else {
      const authorMatch2 = html.match(
        /<span[^>]*class=["'][^"']*profile_nickname["'][^>]*>([^<]+)<\/span>/i
      );
      if (authorMatch2) {
        author = this.cleanText(authorMatch2[1]);
      }
    }

    // 提取发布时间
    let publishTime = '';
    const timeMatch = html.match(
      /<em[^>]*id=["']publish_time["'][^>]*>([^<]+)<\/em>/i
    );
    if (timeMatch) {
      publishTime = this.cleanText(timeMatch[1]);
    }

    // 提取正文
    let content = '';
    const contentMatch = html.match(
      /<div[^>]*id=["']js_content["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/i
    );
    if (contentMatch) {
      content = this.stripTags(contentMatch[1]);
    } else {
      content = this.extractMainContent(html);
    }

    return {
      title,
      author,
      content,
      url,
      publishTime,
      platform: 'wechat',
    };
  }

  /**
   * 通用文章抓取
   */
  async fetchGenericArticle(
    url: string,
    selector?: string
  ): Promise<Article> {
    const platform = this.detectPlatform(url);

    // 根据平台使用专门的抓取逻辑
    if (platform === 'zhihu') {
      return this.fetchZhihuArticle(url);
    }
    if (platform === 'wechat') {
      return this.fetchWechatArticle(url);
    }

    const html = await this.fetchPage(url);
    const title = this.extractTitle(html);

    let content = '';
    if (selector) {
      // 使用自定义选择器
      const regex = new RegExp(
        `<${selector}[^>]*>([\\s\\S]*?)<\\/${selector}>`,
        'i'
      );
      const match = html.match(regex);
      if (match) {
        content = this.stripTags(match[1]);
      }
    }

    if (!content) {
      // 使用平台特定的选择器
      content = await this.extractByPlatform(html, platform);
    }

    if (!content) {
      content = this.extractMainContent(html);
    }

    return {
      title,
      content,
      url,
      platform,
    };
  }

  /**
   * 根据平台使用特定选择器
   */
  private async extractByPlatform(
    html: string,
    platform: string
  ): Promise<string> {
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

    return '';
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
   * 获取文章摘要
   */
  async summarizeArticle(
    url: string,
    platform: string = 'auto'
  ): Promise<ArticleSummary> {
    const detectedPlatform = platform === 'auto' ? this.detectPlatform(url) : platform;

    let article: Article;
    switch (detectedPlatform) {
      case 'zhihu':
        article = await this.fetchZhihuArticle(url);
        break;
      case 'wechat':
        article = await this.fetchWechatArticle(url);
        break;
      default:
        article = await this.fetchGenericArticle(url);
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
