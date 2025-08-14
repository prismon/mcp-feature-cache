#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { FeatureDatabase } from './db/database.js';
import { FeatureOrchestrator } from './core/orchestrator.js';
import { 
  ExtractToolSchema,
  QueryToolSchema,
  RegisterExtractorSchema,
  ListExtractorsSchema,
  UpdateTTLSchema
} from './types/schemas.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('mcp-server');

class FeatureStoreServer {
  private server: Server;
  private db: FeatureDatabase;
  private orchestrator: FeatureOrchestrator;

  constructor() {
    this.server = new Server(
      {
        name: 'mcp-feature-store',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.db = new FeatureDatabase();
    this.orchestrator = new FeatureOrchestrator(this.db);

    this.setupHandlers();
    this.setupCleanupTask();
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'extract',
          description: 'Extract features from a resource using MCP tools',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'File path or URL' },
              extractors: { 
                type: 'array', 
                items: { type: 'string' },
                description: 'Specific extractors to use (optional)'
              },
              ttl: { type: 'number', description: 'TTL in seconds (default: 3600)' },
              stream: { type: 'boolean', description: 'Enable streaming (default: false)' },
              force: { type: 'boolean', description: 'Force re-extraction (default: false)' }
            },
            required: ['url']
          }
        },
        {
          name: 'query',
          description: 'Query features from the store',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'Resource URL (optional)' },
              featureKeys: { 
                type: 'array',
                items: { type: 'string' },
                description: 'Feature keys to retrieve'
              },
              extractors: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter by extractor tools'
              },
              includeExpired: { type: 'boolean', description: 'Include expired features (default: false)' }
            }
          }
        },
        {
          name: 'register_extractor',
          description: 'Register a new MCP feature extractor',
          inputSchema: {
            type: 'object',
            properties: {
              toolName: { type: 'string', description: 'MCP tool name' },
              serverUrl: { type: 'string', description: 'MCP server URL' },
              capabilities: { 
                type: 'array', 
                items: { type: 'string' },
                description: 'Supported MIME types'
              },
              featureKeys: { 
                type: 'array', 
                items: { type: 'string' },
                description: 'Features this tool generates'
              },
              priority: { type: 'number', description: 'Execution priority (default: 100)' }
            },
            required: ['toolName', 'serverUrl', 'capabilities', 'featureKeys']
          }
        },
        {
          name: 'list_extractors',
          description: 'List all registered MCP extractors',
          inputSchema: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean', description: 'Filter by enabled status' },
              capability: { type: 'string', description: 'Filter by MIME type capability' }
            }
          }
        },
        {
          name: 'update_ttl',
          description: 'Update TTL for a specific feature',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'Resource URL' },
              featureKey: { type: 'string', description: 'Feature key' },
              ttl: { type: 'number', description: 'New TTL in seconds' }
            },
            required: ['url', 'featureKey', 'ttl']
          }
        },
        {
          name: 'stats',
          description: 'Get feature store statistics',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        }
      ]
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'extract': {
            const params = ExtractToolSchema.parse(args);
            
            if (params.stream) {
              // Streaming mode
              const results: any[] = [];
              for await (const update of this.orchestrator.extractFeaturesStream(params.url, {
                extractors: params.extractors,
                ttl: params.ttl,
                force: params.force
              })) {
                results.push(update);
              }
              return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
            } else {
              // Non-streaming mode
              const features = await this.orchestrator.extractFeatures(params.url, {
                extractors: params.extractors,
                ttl: params.ttl,
                force: params.force
              });
              return { content: [{ type: 'text', text: JSON.stringify(features, null, 2) }] };
            }
          }

          case 'query': {
            const params = QueryToolSchema.parse(args);
            const features = await this.db.queryFeatures(params);
            return { content: [{ type: 'text', text: JSON.stringify(features, null, 2) }] };
          }

          case 'register_extractor': {
            const params = RegisterExtractorSchema.parse(args);
            await this.db.registerExtractor({
              toolName: params.toolName,
              serverUrl: params.serverUrl,
              capabilities: params.capabilities,
              featureKeys: params.featureKeys,
              priority: params.priority || 100,
              enabled: true
            });
            return { content: [{ type: 'text', text: `Extractor ${params.toolName} registered successfully` }] };
          }

          case 'list_extractors': {
            const params = ListExtractorsSchema.parse(args);
            const extractors = await this.db.getExtractors(params);
            return { content: [{ type: 'text', text: JSON.stringify(extractors, null, 2) }] };
          }

          case 'update_ttl': {
            const params = UpdateTTLSchema.parse(args);
            await this.db.updateTTL(params.url, params.featureKey, params.ttl);
            return { content: [{ type: 'text', text: `TTL updated for ${params.url}/${params.featureKey}` }] };
          }

          case 'stats': {
            const stats = await this.db.getStats();
            return { content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }] };
          }

          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error: any) {
        logger.error(`Tool execution error: ${name}`, error);
        
        if (error instanceof McpError) {
          throw error;
        }
        
        throw new McpError(
          ErrorCode.InternalError,
          error.message || 'Tool execution failed'
        );
      }
    });
  }

  private setupCleanupTask() {
    // Run cleanup every hour
    setInterval(async () => {
      try {
        const deleted = await this.db.cleanExpiredFeatures();
        if (deleted > 0) {
          logger.info(`Cleaned up ${deleted} expired features`);
        }
      } catch (error) {
        logger.error('Cleanup task failed:', error);
      }
    }, 60 * 60 * 1000);
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('MCP Feature Store server started');
  }

  async stop() {
    this.db.close();
    await this.server.close();
    logger.info('MCP Feature Store server stopped');
  }
}

// Start the server
const server = new FeatureStoreServer();

server.start().catch((error) => {
  logger.error('Failed to start server:', error);
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
  await server.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await server.stop();
  process.exit(0);
});