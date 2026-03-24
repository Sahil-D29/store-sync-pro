type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel) || (process.env.NODE_ENV === "production" ? "info" : "debug");

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatMessage(level: LogLevel, context: string, message: string, data?: any): string {
  const timestamp = new Date().toISOString();
  const base = `[${timestamp}] [${level.toUpperCase()}] [${context}] ${message}`;
  return data ? `${base} ${JSON.stringify(data)}` : base;
}

export function createLogger(context: string) {
  return {
    debug(message: string, data?: any) {
      if (shouldLog("debug")) console.log(formatMessage("debug", context, message, data));
    },
    info(message: string, data?: any) {
      if (shouldLog("info")) console.log(formatMessage("info", context, message, data));
    },
    warn(message: string, data?: any) {
      if (shouldLog("warn")) console.warn(formatMessage("warn", context, message, data));
    },
    error(message: string, data?: any) {
      if (shouldLog("error")) console.error(formatMessage("error", context, message, data));
    },
  };
}
