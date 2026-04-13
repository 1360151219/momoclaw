/**
 * MCP (Model Context Protocol) 模块入口
 * 统一导出 MCP 相关功能
 */

export { createArticleFetcherMcpServer, formatArticle } from './server.js';
export { createBrowserMcpServer } from './browser.js';
