/**
 * Simple logger for Feishu module
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

const CURRENT_LEVEL: LogLevel = (process.env.FEISHU_LOG_LEVEL as LogLevel) || 'info';

function shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[CURRENT_LEVEL];
}

function formatMessage(prefix: string, message: string): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${prefix}] ${message}`;
}

export function logger(prefix: string) {
    return {
        debug: (msg: string) => {
            if (shouldLog('debug')) {
                console.log(formatMessage(prefix, msg));
            }
        },
        info: (msg: string) => {
            if (shouldLog('info')) {
                console.log(formatMessage(prefix, msg));
            }
        },
        warn: (msg: string) => {
            if (shouldLog('warn')) {
                console.warn(formatMessage(prefix, msg));
            }
        },
        error: (msg: string) => {
            if (shouldLog('error')) {
                console.error(formatMessage(prefix, msg));
            }
        },
    };
}
