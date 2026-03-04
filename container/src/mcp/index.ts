/**
 * MCP (Model Context Protocol) 模块入口
 * 统一导出 MCP 相关功能
 */

export { createArticleFetcherMcpServer, formatArticle } from './server.js';

export const CRON_TOOLS = ['schedule_task', 'list_scheduled_tasks', 'pause_task', 'resume_task', 'delete_task', 'get_task_logs'];