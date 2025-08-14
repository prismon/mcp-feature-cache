import winston from 'winston';
import { v4 as uuidv4 } from 'uuid';
import { AsyncLocalStorage } from 'async_hooks';
import path from 'path';
import fs from 'fs';

// AsyncLocalStorage for request context tracking
const asyncLocalStorage = new AsyncLocalStorage<Map<string, any>>();

// Enhanced log levels with custom priorities
const customLevels = {
  levels: {
    fatal: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
    trace: 5,
    verbose: 6
  },
  colors: {
    fatal: 'red bold',
    error: 'red',
    warn: 'yellow',
    info: 'green',
    debug: 'blue',
    trace: 'cyan',
    verbose: 'magenta'
  }
};

// Configuration from environment
const config = {
  level: process.env.LOG_LEVEL || 'verbose',
  enableFileLogging: process.env.LOG_TO_FILE === 'true',
  logDir: process.env.LOG_DIR || path.join(process.cwd(), 'logs'),
  maxFileSize: process.env.LOG_MAX_SIZE || '20m',
  maxFiles: process.env.LOG_MAX_FILES || '14d',
  enableJsonLogging: process.env.LOG_JSON === 'true',
  enableStackTrace: process.env.LOG_STACK_TRACE !== 'false',
  enableRequestContext: process.env.LOG_REQUEST_CONTEXT !== 'false'
};

// Ensure log directory exists
if (config.enableFileLogging && !fs.existsSync(config.logDir)) {
  fs.mkdirSync(config.logDir, { recursive: true });
}

// Custom format for detailed logging
const detailedFormat = winston.format.printf(({ 
  level, 
  message, 
  timestamp, 
  service, 
  correlationId,
  requestId,
  userId,
  method,
  path,
  statusCode,
  duration,
  error,
  stack,
  metadata,
  ...rest 
}) => {
  const contextInfo = [
    correlationId && `[CID:${correlationId}]`,
    requestId && `[RID:${requestId}]`,
    userId && `[UID:${userId}]`,
    method && path && `[${method} ${path}]`,
    statusCode && `[${statusCode}]`,
    duration && `[${duration}ms]`
  ].filter(Boolean).join(' ');

  const metaStr = Object.keys(rest).length > 0 ? 
    `\n  META: ${JSON.stringify(rest, null, 2)}` : '';
  
  const errorStr = error ? `\n  ERROR: ${error}` : '';
  const stackStr = stack && config.enableStackTrace ? `\n  STACK: ${stack}` : '';
  const metadataStr = metadata ? `\n  DATA: ${JSON.stringify(metadata, null, 2)}` : '';

  return `${timestamp} [${level.toUpperCase()}] [${service}] ${contextInfo} ${message}${metaStr}${errorStr}${stackStr}${metadataStr}`;
});

// Create base logger configuration
const createBaseLogger = (service: string) => {
  const transports: winston.transport[] = [];

  // Console transport with colors
  transports.push(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize({ all: true }),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        config.enableJsonLogging ? winston.format.json() : detailedFormat
      )
    })
  );

  // File transports
  if (config.enableFileLogging) {
    // Combined log
    transports.push(
      new winston.transports.File({
        filename: path.join(config.logDir, 'combined.log'),
        maxsize: parseInt(config.maxFileSize) * 1024 * 1024,
        maxFiles: config.maxFiles,
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        )
      })
    );

    // Error log
    transports.push(
      new winston.transports.File({
        filename: path.join(config.logDir, 'error.log'),
        level: 'error',
        maxsize: parseInt(config.maxFileSize) * 1024 * 1024,
        maxFiles: config.maxFiles,
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        )
      })
    );

    // Verbose/Debug log
    transports.push(
      new winston.transports.File({
        filename: path.join(config.logDir, 'debug.log'),
        level: 'verbose',
        maxsize: parseInt(config.maxFileSize) * 1024 * 1024,
        maxFiles: config.maxFiles,
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        )
      })
    );
  }

  return winston.createLogger({
    levels: customLevels.levels,
    level: config.level,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp', 'service'] })
    ),
    defaultMeta: { service },
    transports,
    exitOnError: false
  });
};

// Add colors to winston
winston.addColors(customLevels.colors);

// Enhanced logger class with context support
export class EnhancedLogger {
  private logger: winston.Logger;
  private service: string;

  constructor(service: string) {
    this.service = service;
    this.logger = createBaseLogger(service);
  }

  private getContext(): Record<string, any> {
    const store = asyncLocalStorage.getStore();
    if (!store) return {};
    
    return {
      correlationId: store.get('correlationId'),
      requestId: store.get('requestId'),
      userId: store.get('userId'),
      method: store.get('method'),
      path: store.get('path'),
      ...Object.fromEntries(store.entries())
    };
  }

  private log(level: string, message: string, meta?: any) {
    const context = config.enableRequestContext ? this.getContext() : {};
    
    // Add performance timing
    const startTime = context.startTime;
    if (startTime) {
      context.duration = Date.now() - startTime;
    }

    this.logger.log(level, message, { ...context, ...meta });
  }

  // Logging methods with verbose details
  fatal(message: string, error?: Error | any, meta?: any) {
    this.log('fatal', message, { 
      error: error?.message || error,
      stack: error?.stack,
      ...meta 
    });
  }

  error(message: string, error?: Error | any, meta?: any) {
    this.log('error', message, { 
      error: error?.message || error,
      stack: error?.stack,
      ...meta 
    });
  }

  warn(message: string, meta?: any) {
    this.log('warn', message, meta);
  }

  info(message: string, meta?: any) {
    this.log('info', message, meta);
  }

  debug(message: string, meta?: any) {
    this.log('debug', message, meta);
  }

  trace(message: string, meta?: any) {
    this.log('trace', message, meta);
  }

  verbose(message: string, meta?: any) {
    this.log('verbose', message, meta);
  }

  // Performance logging
  startTimer(label: string): () => void {
    const start = Date.now();
    this.trace(`Timer started: ${label}`);
    
    return () => {
      const duration = Date.now() - start;
      this.debug(`Timer ended: ${label}`, { duration, label });
    };
  }

  // Database query logging
  logQuery(query: string, params?: any[], duration?: number) {
    this.verbose('Database query executed', {
      query: query.substring(0, 500), // Truncate long queries
      params: params?.slice(0, 10), // Limit param logging
      paramCount: params?.length,
      duration
    });
  }

  // HTTP request/response logging
  logHttpRequest(method: string, url: string, headers?: any, body?: any) {
    this.debug('HTTP request initiated', {
      method,
      url,
      headers: this.sanitizeHeaders(headers),
      bodySize: JSON.stringify(body || {}).length
    });
  }

  logHttpResponse(status: number, headers?: any, body?: any, duration?: number) {
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'debug';
    this.log(level, 'HTTP response received', {
      statusCode: status,
      headers: this.sanitizeHeaders(headers),
      bodySize: JSON.stringify(body || {}).length,
      duration
    });
  }

  // Feature extraction logging
  logFeatureExtraction(resourceUrl: string, extractorName: string, featureCount: number, duration?: number) {
    this.info('Features extracted', {
      resourceUrl,
      extractor: extractorName,
      featureCount,
      duration
    });
  }

  // Sanitize sensitive headers
  private sanitizeHeaders(headers?: any): any {
    if (!headers) return undefined;
    
    const sanitized = { ...headers };
    const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key', 'x-auth-token'];
    
    for (const header of sensitiveHeaders) {
      if (sanitized[header]) {
        sanitized[header] = '[REDACTED]';
      }
    }
    
    return sanitized;
  }

  // Create child logger with additional context
  child(meta: Record<string, any>): EnhancedLogger {
    const childLogger = new EnhancedLogger(`${this.service}:${meta.component || 'child'}`);
    
    // Override getContext to include parent metadata
    const originalGetContext = childLogger.getContext.bind(childLogger);
    childLogger.getContext = () => ({
      ...originalGetContext(),
      ...meta
    });
    
    return childLogger;
  }
}

// Context management utilities
export class LogContext {
  static run<T>(context: Record<string, any>, callback: () => T): T {
    const store = new Map(Object.entries(context));
    return asyncLocalStorage.run(store, callback);
  }

  static runAsync<T>(context: Record<string, any>, callback: () => Promise<T>): Promise<T> {
    const store = new Map(Object.entries(context));
    return asyncLocalStorage.run(store, callback);
  }

  static set(key: string, value: any): void {
    const store = asyncLocalStorage.getStore();
    if (store) {
      store.set(key, value);
    }
  }

  static get(key: string): any {
    const store = asyncLocalStorage.getStore();
    return store?.get(key);
  }

  static setCorrelationId(id?: string): string {
    const correlationId = id || uuidv4();
    LogContext.set('correlationId', correlationId);
    return correlationId;
  }

  static setRequestId(id?: string): string {
    const requestId = id || uuidv4();
    LogContext.set('requestId', requestId);
    return requestId;
  }
}

// Express middleware for request logging
export function requestLoggingMiddleware(logger: EnhancedLogger) {
  return (req: any, res: any, next: any) => {
    const correlationId = req.headers['x-correlation-id'] || uuidv4();
    const requestId = uuidv4();
    const startTime = Date.now();

    // Set up context
    LogContext.runAsync({
      correlationId,
      requestId,
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      startTime
    }, async () => {
      // Log request
      logger.info('Request received', {
        headers: logger.sanitizeHeaders(req.headers),
        query: req.query,
        bodySize: JSON.stringify(req.body || {}).length
      });

      // Capture response
      const originalSend = res.send;
      res.send = function(data: any) {
        res.send = originalSend;
        
        const duration = Date.now() - startTime;
        LogContext.set('duration', duration);
        LogContext.set('statusCode', res.statusCode);

        // Log response
        const level = res.statusCode >= 500 ? 'error' : 
                     res.statusCode >= 400 ? 'warn' : 'info';
        
        logger.log(level, 'Request completed', {
          statusCode: res.statusCode,
          duration,
          responseSize: data ? data.length : 0
        });

        return res.send(data);
      };

      next();
    });
  };
}

// Factory function for backward compatibility
export function createEnhancedLogger(service: string): EnhancedLogger {
  return new EnhancedLogger(service);
}

// Export singleton for global logging
export const globalLogger = new EnhancedLogger('global');

// Log system startup
globalLogger.info('Enhanced logging system initialized', {
  config,
  levels: Object.keys(customLevels.levels),
  transports: config.enableFileLogging ? ['console', 'file'] : ['console']
});