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


// Weixin user operations
export {
  registerWeixinUser,
  getWeixinUser,
  listWeixinUsers,
  updateWeixinUserStatus,
  updateWeixinUserToken,
  deleteWeixinUser,
  type WeixinUserRow,
} from './weixinUsers.js';

// Weixin mapping operations
export {
  getMapping as getWeixinMapping,
  setMapping as setWeixinMapping,
  deleteMapping as deleteWeixinMapping,
  listMappingsByWxUser,
  getSessionByMapping,
  type WeixinMapping,
} from './weixinMappings.js';
export {
  getChannelMapping,
  setChannelMapping,
  deleteChannelMapping,
  listChannelMappings,
  getChannelByChatSession,
  type ChannelMapping,
} from './channels/channelMappings.js';
