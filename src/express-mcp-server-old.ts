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
import { FeatureType } from './types/index.js';

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
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
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
          const extractors = await sharedDb.getExtractors(params);
          return { content: [{ type: 'text', text: JSON.stringify(extractors, null, 2) }] };
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

// Generic feature value API endpoints

// Get a single feature value
app.get('/api/features/:resourceUrl/:featureKey', async (req: Request, res: Response) => {
  const { resourceId, size } = req.params;
  const timer = logger.startTimer('serve-thumbnail');
  
  logger.debug('Thumbnail request', { resourceId, size });
  
  try {
    // Create database instance for this request
    const db = new FeatureDatabase();
    
    // Query the database for the thumbnail
    const features = await db.queryFeatures({
      featureKeys: [`image.thumbnail_${size}`]
    });
    
    // Find the matching feature by resource ID
    const feature = features.find(f => {
      // Extract resource ID from URL or use checksum
      const urlParts = f.resourceUrl.split('/');
      const id = urlParts[urlParts.length - 1].replace(/\.[^/.]+$/, '');
      return id === resourceId || f.resourceUrl.includes(resourceId);
    });
    
    if (!feature) {
      logger.warn('Thumbnail not found', { resourceId, size });
      res.status(404).json({ error: 'Thumbnail not found' });
      return;
    }
    
    // Convert base64 to buffer
    const imageBuffer = Buffer.from(feature.value, 'base64');
    
    // Set appropriate headers
    res.set({
      'Content-Type': 'image/png',
      'Content-Length': imageBuffer.length.toString(),
      'Cache-Control': 'public, max-age=86400' // Cache for 24 hours
    });
    
    timer();
    logger.verbose('Serving thumbnail', { 
      resourceId, 
      size, 
      bytes: imageBuffer.length 
    });
    
    res.send(imageBuffer);
  } catch (error: any) {
    timer();
    logger.error('Error serving thumbnail', error, { resourceId, size });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Feature media endpoint (for any binary feature)
app.get('/media/:resourceId/:featureKey', async (req: Request, res: Response) => {
  const { resourceId, featureKey } = req.params;
  const timer = logger.startTimer('serve-media');
  
  logger.debug('Media request', { resourceId, featureKey });
  
  try {
    // Create database instance for this request
    const db = new FeatureDatabase();
    
    // Query the database for the feature
    const features = await db.queryFeatures({
      featureKeys: [featureKey]
    });
    
    // Find the matching feature
    const feature = features.find(f => 
      f.resourceUrl.includes(resourceId) && f.featureKey === featureKey
    );
    
    if (!feature) {
      logger.warn('Media not found', { resourceId, featureKey });
      res.status(404).json({ error: 'Media not found' });
      return;
    }
    
    // Determine content type based on feature key
    let contentType = 'application/octet-stream';
    if (featureKey.includes('thumbnail') || featureKey.includes('snapshot')) {
      contentType = 'image/png';
    } else if (featureKey.includes('video')) {
      contentType = 'video/mp4';
    }
    
    // Convert base64 to buffer
    const mediaBuffer = Buffer.from(feature.value, 'base64');
    
    res.set({
      'Content-Type': contentType,
      'Content-Length': mediaBuffer.length.toString(),
      'Cache-Control': 'public, max-age=86400'
    });
    
    timer();
    logger.verbose('Serving media', { 
      resourceId, 
      featureKey, 
      bytes: mediaBuffer.length 
    });
    
    res.send(mediaBuffer);
  } catch (error: any) {
    timer();
    logger.error('Error serving media', error, { resourceId, featureKey });
    res.status(500).json({ error: 'Internal server error' });
  }
});

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

// Session termination not needed in stateless mode
app.delete('/mcp', async (req: Request, res: Response) => {
  logger.debug('Received DELETE MCP request');
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed."
    },
    id: null
  });
});

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'mcp-feature-store' });
});

// Root endpoint for documentation
app.get('/', (req: Request, res: Response) => {
  res.json({
    name: 'MCP Feature Store - Express Server',
    version: '1.0.0',
    transport: 'Streamable HTTP (stateless)',
    endpoint: '/mcp',
    method: 'POST',
    contentType: 'application/json',
    example: {
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {},
      id: 1
    },
    tools: [
      'extract - Extract features from resources',
      'query - Query stored features',
      'stats - Get database statistics',
      'list_extractors - List registered extractors',
      'register_extractor - Register new extractor',
      'update_ttl - Update feature TTL'
    ]
  });
});

// Setup function for any initialization
async function setupServer() {
  // Initialize database if needed
  const db = new FeatureDatabase();
  const stats = await db.getStats();
  logger.info(`Database initialized with ${stats.totalResources} resources and ${stats.totalFeatures} features`);
  db.close();
  
  // Setup cleanup task
  setInterval(async () => {
    try {
      const cleanupDb = new FeatureDatabase();
      const deleted = await cleanupDb.cleanExpiredFeatures();
      if (deleted > 0) {
        logger.info(`Cleaned up ${deleted} expired features`);
      }
      cleanupDb.close();
    } catch (error) {
      logger.error('Cleanup task failed:', error);
    }
  }, 60 * 60 * 1000); // Every hour
}

// Parse command line arguments
const PORT = parseInt(process.argv[2]) || parseInt(process.env.PORT || '3000');

if (process.argv.includes('--help')) {
  console.log(`
MCP Feature Store - Express Server with Streamable HTTP

This server implements the MCP protocol using Express and StreamableHTTPServerTransport.
Each request creates a new server instance for complete isolation (stateless mode).

Usage:
  npm run express-mcp [port]        Start server on specified port (default: 3000)
  npm run express-mcp:dev [port]    Start in development mode with auto-reload
  
Examples:
  npm run express-mcp               Start on default port 3000
  npm run express-mcp 8080          Start on port 8080
  PORT=4000 npm run express-mcp     Start on port 4000 via env variable

Endpoints:
  POST /mcp      - MCP protocol endpoint
  GET /health    - Health check
  GET /          - API documentation

Testing with curl:
  # List tools
  curl -X POST http://localhost:${PORT}/mcp \\
    -H "Content-Type: application/json" \\
    -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}'

  # Get stats
  curl -X POST http://localhost:${PORT}/mcp \\
    -H "Content-Type: application/json" \\
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"stats","arguments":{}},"id":2}'

Testing with MCP Inspector:
  1. Start the server: npm run express-mcp ${PORT}
  2. Open MCP Inspector
  3. Connect to: http://localhost:${PORT}
  4. Select "Streamable HTTP" as transport type

Environment Variables:
  PORT           Server port (default: 3000)
  DATABASE_PATH  Path to SQLite database
  LOG_LEVEL      Logging level (info, debug, error)
`);
  process.exit(0);
}

// Start the server
setupServer().then(() => {
  app.listen(PORT, () => {
    logger.info(`🚀 MCP Express Server (Stateless) listening on port ${PORT}`);
    logger.info(`📡 MCP endpoint: http://localhost:${PORT}/mcp`);
    logger.info(`📚 API docs: http://localhost:${PORT}/`);
    logger.info(`🏥 Health check: http://localhost:${PORT}/health`);
    logger.info('\nTest with:');
    logger.info(`  curl -X POST http://localhost:${PORT}/mcp \\`);
    logger.info(`    -H "Content-Type: application/json" \\`);
    logger.info(`    -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}'`);
  });
}).catch(error => {
  logger.error('Failed to set up the server:', error);
  process.exit(1);
});