// Database connection
export { initDatabase, getDb } from './connection.js';

// Session operations
export {
    createSession,
    getSession,
    getActiveSession,
    listSessions,
    switchSession,
    deleteSession,
    updateSessionPrompt,
    updateSessionModel,
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
