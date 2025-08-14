import { createEnhancedLogger, EnhancedLogger } from './enhanced-logger.js';

// Re-export the enhanced logger for backward compatibility
export function createLogger(service: string): EnhancedLogger {
  return createEnhancedLogger(service);
}

// Export types and utilities from enhanced logger
export { EnhancedLogger, LogContext, requestLoggingMiddleware } from './enhanced-logger.js';