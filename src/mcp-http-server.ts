#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { createServer, IncomingMessage, ServerResponse } from 'http';
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

const logger = createLogger('mcp-http-server');

class MCPHttpServer {
  private mcpServer: Server;
  private db: FeatureDatabase;
  private orchestrator: FeatureOrchestrator;
  private port: number;

  constructor(port: number = 3000) {
    this.port = port;
    this.db = new FeatureDatabase();
    this.orchestrator = new FeatureOrchestrator(this.db);

    // Initialize MCP server
    this.mcpServer = new Server(
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

    this.setupMCPHandlers();
  }

  private setupMCPHandlers() {
    // List available tools
    this.mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
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
    this.mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'extract': {
            const params = ExtractToolSchema.parse(args);
            
            if (params.stream) {
              // Streaming mode - return results incrementally
              const results: any[] = [];
              for await (const update of this.orchestrator.extractFeaturesStream(params.url, {
                extractors: params.extractors,
                ttl: params.ttl,
                force: params.force
              })) {
                results.push(update);
                // In a real streaming scenario, we'd yield here
                // but MCP tools don't support streaming responses yet
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

  async start() {
    // Create HTTP server with handler
    const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // Handle SSE endpoint
      if (req.url === '/mcp' || req.url === '/sse') {
        logger.info(`SSE connection from ${req.socket.remoteAddress}`);
        
        // Create transport for this specific request/response
        const transport = new SSEServerTransport('/sse', res);
        await this.mcpServer.connect(transport);
        
        // Keep connection alive
        req.on('close', () => {
          logger.info('SSE connection closed');
        });
      } else if (req.url === '/') {
        // API documentation
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          name: 'MCP Feature Store - SSE Server',
          version: '1.0.0',
          endpoint: `http://localhost:${this.port}/sse`,
          instructions: {
            connect: `curl -N http://localhost:${this.port}/sse`,
            listTools: 'Send JSON-RPC request with method "tools/list"',
            callTool: 'Send JSON-RPC request with method "tools/call"'
          },
          example: {
            jsonrpc: '2.0',
            method: 'tools/list',
            params: {},
            id: 1
          }
        }, null, 2));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    // Start HTTP server
    httpServer.listen(this.port, () => {
      logger.info(`🚀 MCP HTTP Server with SSE transport listening on port ${this.port}`);
      logger.info(`📡 SSE endpoint: http://localhost:${this.port}/sse`);
      logger.info(`📚 API info: http://localhost:${this.port}/`);
      logger.info('\nConnect with SSE client:');
      logger.info(`  curl -N -H "Accept: text/event-stream" http://localhost:${this.port}/sse`);
    });

    // Setup cleanup task
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

    // Graceful shutdown
    process.on('SIGINT', async () => {
      logger.info('Shutting down MCP HTTP server...');
      await this.mcpServer.close();
      this.db.close();
      httpServer.close();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Shutting down MCP HTTP server...');
      await this.mcpServer.close();
      this.db.close();
      httpServer.close();
      process.exit(0);
    });
  }
}

// Parse command line arguments
const port = parseInt(process.argv[2]) || parseInt(process.env.PORT || '3000');

if (process.argv.includes('--help')) {
  console.log(`
MCP Feature Store - HTTP Server with SSE Transport

Usage:
  npm run mcp-http [port]        Start MCP HTTP server on specified port (default: 3000)
  npm run mcp-http:dev [port]    Start in development mode with auto-reload
  
Examples:
  npm run mcp-http               Start on default port 3000
  npm run mcp-http 8080          Start on port 8080
  PORT=4000 npm run mcp-http     Start on port 4000 via env variable

SSE Endpoint:
  http://localhost:${port}/sse

Connect with SSE:
  curl -N -H "Accept: text/event-stream" http://localhost:${port}/sse

Then send JSON-RPC messages through the SSE connection.

Example Messages:
  # List tools
  {"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}

  # Get stats
  {"jsonrpc":"2.0","method":"tools/call","params":{"name":"stats","arguments":{}},"id":2}

  # Extract features
  {"jsonrpc":"2.0","method":"tools/call","params":{"name":"extract","arguments":{"url":"/path/to/image.jpg"}},"id":3}

Environment Variables:
  PORT                          Server port (default: 3000)
  DATABASE_PATH                 Path to SQLite database
  LOG_LEVEL                     Logging level (info, debug, error)
`);
  process.exit(0);
}

// Start server
const server = new MCPHttpServer(port);
server.start().catch(error => {
  logger.error('Failed to start server:', error);
  process.exit(1);
});