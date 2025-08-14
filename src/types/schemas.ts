import { z } from 'zod';
import { FeatureType } from './index.js';

export const ExtractToolSchema = z.object({
  url: z.string().describe('File path or URL to extract features from'),
  extractors: z.array(z.string()).optional().describe('Specific extractors to use (optional)'),
  ttl: z.number().optional().default(3600).describe('TTL in seconds'),
  stream: z.boolean().optional().default(false).describe('Enable streaming mode'),
  force: z.boolean().optional().default(false).describe('Force re-extraction'),
  includeEmbeddings: z.boolean().optional().default(false).describe('Generate embeddings for text content')
});

export const QueryToolSchema = z.object({
  url: z.string().optional().describe('Resource URL (optional)'),
  featureKeys: z.array(z.string()).optional().describe('Feature keys to retrieve'),
  extractors: z.array(z.string()).optional().describe('Filter by extractor tools'),
  includeExpired: z.boolean().optional().default(false).describe('Include expired features')
});

export const RegisterExtractorSchema = z.object({
  toolName: z.string().describe('MCP tool name'),
  serverUrl: z.string().describe('MCP server URL'),
  capabilities: z.array(z.string()).describe('Supported MIME types'),
  featureKeys: z.array(z.string()).describe('Features this tool generates'),
  priority: z.number().optional().default(100).describe('Execution priority')
});

export const ListExtractorsSchema = z.object({
  enabled: z.boolean().optional().describe('Filter by enabled status'),
  capability: z.string().optional().describe('Filter by MIME type capability')
});

export const UpdateTTLSchema = z.object({
  url: z.string().describe('Resource URL'),
  featureKey: z.string().describe('Feature key'),
  ttl: z.number().describe('New TTL in seconds')
});

export const FeatureValueSchema = z.object({
  key: z.string(),
  value: z.any(),
  type: z.nativeEnum(FeatureType),
  ttl: z.number().optional(),
  metadata: z.record(z.any()).optional()
});

export const ExtractorOutputSchema = z.object({
  features: z.array(FeatureValueSchema),
  extractorVersion: z.string(),
  processingTime: z.number()
});

export type ExtractToolInput = z.infer<typeof ExtractToolSchema>;
export type QueryToolInput = z.infer<typeof QueryToolSchema>;
export type RegisterExtractorInput = z.infer<typeof RegisterExtractorSchema>;
export type ListExtractorsInput = z.infer<typeof ListExtractorsSchema>;
export type UpdateTTLInput = z.infer<typeof UpdateTTLSchema>;