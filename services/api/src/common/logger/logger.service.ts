import { Injectable, LoggerService as NestLoggerService } from '@nestjs/common';

const SENSITIVE_KEYS = [
  'password',
  'token',
  'secret',
  'authorization',
  'apikey',
  'api_key',
  'access_token',
  'cookie',
  'set-cookie',
];

export function redactSensitiveData(obj: any, depth = 0): any {
  if (depth > 5 || obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    // Redact JWT tokens
    if (/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/.test(obj)) {
      return '[REDACTED_JWT]';
    }
    // Redact Bearer tokens
    if (obj.toLowerCase().startsWith('bearer ')) {
      return 'Bearer [REDACTED]';
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveData(item, depth + 1));
  }

  if (typeof obj === 'object') {
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      const lower = key.toLowerCase();
      if (SENSITIVE_KEYS.some((sensitive) => lower.includes(sensitive))) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = redactSensitiveData(value, depth + 1);
      }
    }
    return sanitized;
  }

  return obj;
}

@Injectable()
export class StructuredLogger implements NestLoggerService {
  private formatMessage(level: string, message: any, context?: string): string {
    const timestamp = new Date().toISOString();
    const cleanContext = context ? `[${context}] ` : '';
    const cleanMessage = typeof message === 'object' ? JSON.stringify(redactSensitiveData(message)) : message;
    return `[${timestamp}] [${level.toUpperCase()}] ${cleanContext}${cleanMessage}`;
  }

  log(message: any, context?: string) {
    console.log(this.formatMessage('info', message, context));
  }

  error(message: any, trace?: string, context?: string) {
    console.error(this.formatMessage('error', message, context));
    if (trace && process.env.NODE_ENV !== 'production') {
      console.error(trace);
    }
  }

  warn(message: any, context?: string) {
    console.warn(this.formatMessage('warn', message, context));
  }

  debug?(message: any, context?: string) {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(this.formatMessage('debug', message, context));
    }
  }

  verbose?(message: any, context?: string) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(this.formatMessage('verbose', message, context));
    }
  }
}
