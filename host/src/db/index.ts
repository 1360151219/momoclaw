// Database connection
export { initDatabase, getDb } from './connection.js';

// Session operations
export {
  createSession,
  getSession,
  getActiveSession,
  getActiveSessionForChannel,
  listSessions,
  switchSession,
  deleteSession,
  updateSessionPrompt,
  updateSessionModel,
  updateSessionSummary,
  updateSession,
} from './sessions.js';

// Message operations
export {
  addMessage,
  getSessionMessages,
  clearSessionMessages,
} from './messages.js';

// Task operations
export {
  // Scheduled tasks
  createScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  listTasksByChannel,
  getDueTasks,
  updateTaskAfterRun,
  updateTaskStatus,
  updateTaskNextRun,
  deleteScheduledTask,
  // Task run logs
  addTaskRunLog,
  getTaskRunLogs,
  // Cleanup
  cleanupOldMessages,
  getDatabaseStats,
} from './tasks.js';

// 通用渠道映射（飞书/微信/未来渠道统一使用）
export {
  getChannelMapping,
  setChannelMapping,
  deleteChannelMapping,
  listChannelMappings,
  getChannelByChatSession,
  type ChannelMapping,
} from './channels/channelMappings.js';
