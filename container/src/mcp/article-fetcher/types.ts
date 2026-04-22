export interface Article {
  title: string;
  author?: string;
  content: string;
  url: string;
  publishTime?: string;
  platform: string;
  hasMore?: boolean;
  nextOffset?: number;
}

export interface FetchOptions {
  offset?: number;
  limit?: number;
}

export interface Extractor {
  /**
   * 判断此 Extractor 是否适用于该 URL
   */
  match(url: string): boolean;

  /**
   * 提取文章内容
   * @param url 文章地址
   * @param html 网页源码
   * @param options 抓取选项
   */
  extract(url: string, html: string, options?: FetchOptions): Promise<Article>;
}