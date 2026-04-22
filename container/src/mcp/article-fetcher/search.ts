import DuckDuckGoService from 'ddgs';

export type SearchType = 'web' | 'news' | 'images' | 'videos';

export interface ArticleSearchOptions {
  limit?: number;
  language?: string;
  region?: string;
  safeSearch?: boolean;
  timeout?: number;
  maxRetries?: number;
}

export interface ArticleSearchResult {
  query: string;
  searchType: SearchType;
  limit: number;
  results: unknown[];
}

export class ArticleSearchService {
  /**
   * 使用 ddgs 执行搜索。
   * 这里统一封装成一个方法，MCP 层只需要关心参数输入和结果输出，
   * 不需要知道 ddgs 内部是怎么区分 web / news / images / videos 的。
   */
  async search(
    query: string,
    searchType: SearchType = 'web',
    options: ArticleSearchOptions = {},
  ): Promise<ArticleSearchResult> {
    const limit = normalizeLimit(options.limit);
    const ddg = new DuckDuckGoService({
      timeout: options.timeout ?? 10_000,
      maxRetries: options.maxRetries ?? 3,
      language: options.language ?? 'zh-CN',
      region: options.region ?? 'cn-zh',
      safeSearch: options.safeSearch ?? true,
    });

    try {
      const results = await this.runSearch(ddg, query, searchType);

      return {
        query,
        searchType,
        limit,
        // ddgs 文档没有通用 limit 参数，所以这里在 MCP 层做一次截断，
        // 这样调用方拿到的结果数量更稳定、更可预期。
        results: results.slice(0, limit),
      };
    } catch (error: unknown) {
      throw new Error(formatSearchError(error));
    } finally {
      // ddgs 使用结束后需要主动关闭，避免底层资源长期占用。
      await ddg.close().catch(() => undefined);
    }
  }

  /**
   * 根据搜索类型分发到 ddgs 的不同 API。
   */
  private async runSearch(
    ddg: DuckDuckGoService,
    query: string,
    searchType: SearchType,
  ): Promise<unknown[]> {
    switch (searchType) {
      case 'news':
        return await ddg.searchNews(query);
      case 'images':
        return await ddg.searchImages(query);
      case 'videos':
        return await ddg.searchVideos(query);
      case 'web': {
        const response = await ddg.search(query);
        return response.results;
      }
      default:
        return [];
    }
  }
}

/**
 * 对 limit 做边界保护，避免一次返回太多结果。
 */
function normalizeLimit(limit?: number): number {
  if (!limit || Number.isNaN(limit)) {
    return 5;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), 10);
}

/**
 * 将第三方库抛出的异常转换成更稳定、更好理解的错误信息。
 */
function formatSearchError(error: unknown): string {
  if (error instanceof Error) {
    return `DDGS search failed: ${error.message}`;
  }

  return 'DDGS search failed: Unknown error';
}
