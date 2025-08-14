export enum FeatureType {
  TEXT = 'text',
  NUMBER = 'number',
  BINARY = 'binary',
  EMBEDDING = 'embedding',
  JSON = 'json'
}

export enum ResourceType {
  FILE = 'file',
  URL = 'url'
}

export interface Feature {
  id: string;
  resourceUrl: string;
  featureKey: string;
  value: string;
  valueType: FeatureType;
  generatedAt: number;
  ttl: number;
  expiresAt: number;
  extractorTool: string;
  metadata: Record<string, any>;
}

export interface Resource {
  url: string;
  type: ResourceType;
  lastProcessed: number;
  checksum?: string;
  size?: number;
  mimeType?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface ExtractorRegistry {
  toolName: string;
  serverUrl: string;
  capabilities: string[];
  featureKeys: string[];
  priority: number;
  enabled: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface ExtractFeaturesInput {
  resourceUrl: string;
  content?: string;
  contentType: string;
  metadata?: Record<string, any>;
}

export interface ExtractFeaturesOutput {
  features: Array<{
    key: string;
    value: any;
    type: FeatureType;
    ttl?: number;
    metadata?: Record<string, any>;
  }>;
  extractorVersion: string;
  processingTime: number;
}

export interface StreamUpdate {
  type: 'extraction_started' | 'feature_extracted' | 'extraction_complete' | 'extraction_error';
  resourceUrl: string;
  extractor?: string;
  features?: Array<{
    key: string;
    value: any;
    type: FeatureType;
  }>;
  error?: string;
  progress?: number;
  timestamp: number;
}