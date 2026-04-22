declare module 'ddgs' {
  export interface DuckDuckGoConfig {
    timeout?: number;
    maxRetries?: number;
    language?: string;
    region?: string;
    safeSearch?: boolean;
  }

  export interface WebSearchResponse {
    results: unknown[];
  }

  /**
   * 这是当前项目使用到的最小类型声明。
   * 这里只补齐实际会调用的方法，目的是让 TypeScript 能识别 ddgs 模块。
   */
  export default class DuckDuckGoService {
    constructor(config?: DuckDuckGoConfig);
    search(query: string): Promise<WebSearchResponse>;
    searchImages(query: string): Promise<unknown[]>;
    searchVideos(query: string): Promise<unknown[]>;
    searchNews(query: string): Promise<unknown[]>;
    close(): Promise<void>;
  }
}
