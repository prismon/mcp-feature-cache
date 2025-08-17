#!/usr/bin/env node

import express, { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { FeatureDatabase } from './db/database.js';
import { DirectFeatureOrchestrator } from './core/direct-orchestrator.js';
import { 
  ExtractToolSchema,
  QueryToolSchema,
  RegisterExtractorSchema,
  ListExtractorsSchema,
  UpdateTTLSchema
} from './types/schemas.js';
import { createLogger, requestLoggingMiddleware, LogContext } from './utils/logger.js';
import { setupApiEndpoints } from './api-endpoints.js';

const logger = createLogger('express-mcp-server');

// Create shared database connection (SQLite handles concurrency with WAL mode)
const sharedDb = new FeatureDatabase();

// Create a function that returns a new server instance for each request
function getServer(): Server {
  const orchestrator = new DirectFeatureOrchestrator(sharedDb);
  
  const server = new Server(
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

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.trace('ListTools request received');
    const tools = ({
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
            force: { type: 'boolean', description: 'Force re-extraction (default: false)' },
            includeEmbeddings: { type: 'boolean', description: 'Generate embeddings for text content (requires OPENAI_API_KEY)' }
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
            includeExpired: { type: 'boolean', description: 'Include expired features' }
          }
        }
      },
      {
        name: 'register_extractor',
        description: 'Register a new feature extractor',
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
        description: 'List registered extractors',
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
        description: 'Update TTL for a feature',
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
        description: 'Get database statistics',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }
    ]
  });
    return tools;
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const timer = logger.startTimer(`tool-${name}`);
    
    logger.info(`Tool called: ${name}`, {
      toolName: name,
      argsPreview: JSON.stringify(args).substring(0, 500)
    });

    try {
      logger.trace(`Processing tool: ${name}`);
      switch (name) {
        case 'extract': {
          const params = ExtractToolSchema.parse(args);
          logger.debug('Extract tool validated', {
            url: params.url,
            stream: params.stream,
            force: params.force,
            includeEmbeddings: params.includeEmbeddings,
            extractorCount: params.extractors?.length || 0
          });
          
          if (params.stream) {
            // Streaming mode
            logger.debug('Starting streaming extraction', { url: params.url });
            const results: any[] = [];
            let updateCount = 0;
            
            for await (const update of orchestrator.extractFeaturesStream(params.url, {
              extractors: params.extractors,
              ttl: params.ttl,
              force: params.force,
              includeEmbeddings: params.includeEmbeddings
            })) {
              updateCount++;
              logger.trace(`Stream update #${updateCount}`, {
                type: update.type,
                resourceUrl: update.resourceUrl
              });
              results.push(update);
            }
            
            timer();
            logger.info('Streaming extraction completed', {
              url: params.url,
              updates: updateCount
            });
            return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
          } else {
            // Non-streaming mode
            logger.debug('Starting non-streaming extraction', { url: params.url });
            const extractTimer = logger.startTimer('extract-features');
            
            const features = await orchestrator.extractFeatures(params.url, {
              extractors: params.extractors,
              ttl: params.ttl,
              force: params.force,
              includeEmbeddings: params.includeEmbeddings
            });
            
            extractTimer();
            timer();
            logger.info('Non-streaming extraction completed', {
              url: params.url,
              featureCount: features.length
            });
            return { content: [{ type: 'text', text: JSON.stringify(features, null, 2) }] };
          }
        }

        case 'query': {
          const params = QueryToolSchema.parse(args);
          const features = await sharedDb.queryFeatures(params);
          
          // Check if we have any features for this URL
          if (features.length === 0 && params.url) {
            // Check if the resource exists at all
            const resources = await sharedDb.getResources({ url: params.url });
            if (resources.length === 0) {
              return { 
                content: [{ 
                  type: 'text', 
                  text: `No features found for ${params.url}.\n\nThis path has not been extracted yet. Please run 'extract' on this path first to generate features.\n\nExample:\n  extract url="${params.url}"` 
                }] 
              };
            }
          }
          
          return { content: [{ type: 'text', text: JSON.stringify(features, null, 2) }] };
        }

        case 'register_extractor': {
          const params = RegisterExtractorSchema.parse(args);
          await sharedDb.registerExtractor({
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
          // Return built-in extractors since we're using DirectFeatureOrchestrator
          const builtInExtractors = [
            {
              toolName: 'text-extractor',
              description: 'Extracts text content, word count, line count, and character count',
              capabilities: ['text/plain', 'text/typescript', 'text/javascript', 'text/python', 'text/markdown'],
              enabled: true,
              priority: 1
            },
            {
              toolName: 'image-extractor',
              description: 'Extracts image metadata and generates thumbnails (150x150, 400x400, 1920x1080)',
              capabilities: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
              enabled: true,
              priority: 2
            },
            {
              toolName: 'video-extractor',
              description: 'Extracts video snapshots at 10% intervals',
              capabilities: ['video/mp4', 'video/quicktime', 'video/x-msvideo'],
              enabled: true,
              priority: 3
            },
            {
              toolName: 'directory-extractor',
              description: 'Extracts directory metadata including file count, total size, and file listing',
              capabilities: ['inode/directory'],
              enabled: true,
              priority: 4
            },
            {
              toolName: 'embedding-extractor',
              description: 'Generates text embeddings for RAG (requires OPENAI_API_KEY)',
              capabilities: ['text/plain', 'text/markdown'],
              enabled: !!process.env.OPENAI_API_KEY,
              priority: 5
            }
          ];
          
          // Filter by params if provided
          let filteredExtractors = builtInExtractors;
          if (params.enabled !== undefined) {
            filteredExtractors = filteredExtractors.filter(e => e.enabled === params.enabled);
          }
          if (params.capability) {
            filteredExtractors = filteredExtractors.filter(e => 
              e.capabilities.includes(params.capability)
            );
          }
          
          return { content: [{ type: 'text', text: JSON.stringify(filteredExtractors, null, 2) }] };
        }

        case 'update_ttl': {
          const params = UpdateTTLSchema.parse(args);
          await sharedDb.updateTTL(params.url, params.featureKey, params.ttl);
          return { content: [{ type: 'text', text: `TTL updated for ${params.url}/${params.featureKey}` }] };
        }

        case 'stats': {
          const stats = await sharedDb.getStats();
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

  return server;
}

// Create Express app
const app = express();
app.use(express.json());

// Add request logging middleware
app.use(requestLoggingMiddleware(logger));

// Verbose logging for all requests
app.use((req, res, next) => {
  logger.verbose(`Incoming ${req.method} request to ${req.path}`, {
    query: req.query,
    headers: req.headers,
    bodySize: req.body ? JSON.stringify(req.body).length : 0
  });
  next();
});

// Setup API endpoints for feature values
setupApiEndpoints(app, sharedDb);

// Main MCP endpoint
app.post('/mcp', async (req: Request, res: Response) => {
  // In stateless mode, create a new instance of transport and server for each request
  // to ensure complete isolation. A single instance would cause request ID collisions
  // when multiple clients connect concurrently.
  
  const timer = logger.startTimer('mcp-request');
  const requestId = LogContext.get('requestId');
  
  logger.debug('Processing MCP POST request', {
    requestId,
    bodySize: JSON.stringify(req.body).length,
    jsonrpcMethod: req.body?.method,
    jsonrpcId: req.body?.id
  });
  
  try {
    logger.trace('Creating new server instance for stateless request', { requestId });
    const server = getServer();
    
    logger.trace('Creating StreamableHTTPServerTransport', { 
      requestId,
      sessionIdGenerator: 'undefined (stateless)'
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    
    res.on('close', () => {
      logger.debug('HTTP connection closed, cleaning up MCP resources', { requestId });
      transport.close();
      server.close();
    });
    
    logger.trace('Connecting MCP server to transport', { requestId });
    await server.connect(transport);
    
    logger.trace('Delegating request handling to transport', { 
      requestId,
      hasBody: !!req.body
    });
    await transport.handleRequest(req, res, req.body);
    
    timer();
    logger.debug('MCP request completed successfully', { requestId });
  } catch (error: any) {
    timer();
    logger.error('Error handling MCP request', error, { 
      requestId,
      errorCode: error.code,
      errorMessage: error.message,
      stack: error.stack
    });
    
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

// SSE notifications not supported in stateless mode
app.get('/mcp', async (req: Request, res: Response) => {
  logger.debug('Received GET MCP request');
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. Use POST for MCP requests."
    },
    id: null
  });
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'mcp-feature-store' });
});

// Welcome/documentation endpoint
app.get('/', (req: Request, res: Response) => {
  res.json({
    service: 'MCP Feature Store',
    version: '1.0.0',
    endpoints: {
      mcp: '/mcp',
      health: '/health',
      features: {
        single: '/api/features/:resourceUrl/:featureKey',
        batch: '/api/features/batch',
        list: '/api/features/:resourceUrl'
      },
      thumbnails: '/thumbnails/:resourceId/:size'
    },
    documentation: 'https://github.com/your-org/mcp-feature-store'
  });
});

// Get resource/feature count on startup
const getDbStats = async () => {
  try {
    const stats = await sharedDb.getStats();
    return `${stats.totalResources} resources and ${stats.totalFeatures} features`;
  } catch (error) {
    logger.warn('Could not get database stats', error);
    return 'database';
  }
};

// Start server
const PORT = Number(process.env.PORT || process.argv[2] || 3033);
const HOST = process.env.HOST || '0.0.0.0'; // Listen on all interfaces by default

const server = app.listen(PORT, HOST, async () => {
  const stats = await getDbStats();
  logger.info(`Database initialized with ${stats}`);
  logger.info(`🚀 MCP Express Server (Stateless) listening on ${HOST}:${PORT}`);
  logger.info(`📡 MCP endpoint: http://${HOST}:${PORT}/mcp`);
  logger.info(`📚 API docs: http://${HOST}:${PORT}/`);
  logger.info(`🏥 Health check: http://${HOST}:${PORT}/health`);
  logger.info(`
Test with:
  curl -X POST http://${HOST}:${PORT}/mcp \\
    -H "Content-Type: application/json" \\
    -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}'`);
});

// Verify server is actually listening
server.on('listening', () => {
  const addr = server.address();
  if (addr && typeof addr === 'object') {
    logger.info(`✅ Server confirmed listening on ${addr.address}:${addr.port}`);
  }
});

// Handle server errors
server.on('error', (error: any) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`Port ${PORT} is already in use`);
  } else if (error.code === 'EACCES') {
    logger.error(`Permission denied to bind to ${HOST}:${PORT}`);
  } else {
    logger.error('Server error:', error);
  }
  process.exit(1);
});
