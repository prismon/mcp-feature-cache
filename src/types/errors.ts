export enum ErrorCode {
  EXTRACTOR_UNAVAILABLE = 'EXTRACTOR_UNAVAILABLE',
  EXTRACTOR_TIMEOUT = 'EXTRACTOR_TIMEOUT',
  EXTRACTION_FAILED = 'EXTRACTION_FAILED',
  MCP_CONNECTION_FAILED = 'MCP_CONNECTION_FAILED',
  INVALID_TOOL_RESPONSE = 'INVALID_TOOL_RESPONSE',
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  INVALID_URL = 'INVALID_URL',
  TTL_EXCEEDED = 'TTL_EXCEEDED',
  DATABASE_ERROR = 'DATABASE_ERROR',
  EXTRACTOR_NOT_FOUND = 'EXTRACTOR_NOT_FOUND'
}

export class FeatureStoreError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public extractor?: string,
    public context?: any
  ) {
    super(message);
    this.name = 'FeatureStoreError';
    Object.setPrototypeOf(this, FeatureStoreError.prototype);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      extractor: this.extractor,
      context: this.context
    };
  }
}