type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: any;
}

function log(level: LogLevel, msg: string, meta: Record<string, any> = {}) {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...meta,
  };
  const out = level === 'error' ? process.stderr : process.stdout;
  out.write(JSON.stringify(entry) + '\n');
}

export const logger = {
  debug: (msg: string, meta?: Record<string, any>) => log('debug', msg, meta),
  info: (msg: string, meta?: Record<string, any>) => log('info', msg, meta),
  warn: (msg: string, meta?: Record<string, any>) => log('warn', msg, meta),
  error: (msg: string, meta?: Record<string, any>) => log('error', msg, meta),
};
