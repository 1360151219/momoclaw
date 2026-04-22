import { LRUCache } from 'lru-cache';
import type { Article } from './types.js';

export const articleCache = new LRUCache<string, Article>({
  max: 100, // 最多缓存 100 篇文章
  ttl: 1000 * 60 * 15, // 15 分钟过期
});