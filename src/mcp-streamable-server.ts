#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { Readable } from 'stream';
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

const logger = createLogger('mcp-streamable-server');

class MCPStreamableServer {
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

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    if (req.url === '/') {
      // API documentation
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({
        name: 'MCP Feature Store - Streamable HTTP Server',
        version: '1.0.0',
        endpoint: `http://localhost:${this.port}/mcp`,
        transport: 'Streamable HTTP (JSON-RPC over HTTP)',
        instructions: {
          connect: 'Send POST requests to /mcp with JSON-RPC payloads',
          listTools: 'POST /mcp with method "tools/list"',
          callTool: 'POST /mcp with method "tools/call"'
        },
        example: {
          url: `http://localhost:${this.port}/mcp`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: {
            jsonrpc: '2.0',
            method: 'tools/list',
            params: {},
            id: 1
          }
        }
      }, null, 2));
      return;
    }

    if (req.url === '/mcp' && req.method === 'POST') {
      // Handle MCP JSON-RPC requests
      let body = '';
      
      req.on('data', chunk => {
        body += chunk.toString();
      });

      req.on('end', async () => {
        try {
          const request = JSON.parse(body);
          logger.debug('Received request:', request);

          // Process the request through MCP server
          let response;
          
          if (request.method === 'tools/list') {
            const handler = this.mcpServer.getRequestHandler(ListToolsRequestSchema);
            if (handler) {
              response = await handler(request);
            }
          } else if (request.method === 'tools/call') {
            const handler = this.mcpServer.getRequestHandler(CallToolRequestSchema);
            if (handler) {
              response = await handler(request);
            }
          } else {
            response = {
              jsonrpc: '2.0',
              error: {
                code: -32601,
                message: 'Method not found'
              },
              id: request.id
            };
          }

          // Send response
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
          });
          
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            result: response,
            id: request.id
          }));

        } catch (error: any) {
          logger.error('Request processing error:', error);
          
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32700,
              message: 'Parse error',
              data: error.message
            },
            id: null
          }));
        }
      });
    } else if (req.method === 'OPTIONS') {
      // Handle CORS preflight
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  }

  async start() {
    // Create HTTP server
    const httpServer = createServer((req, res) => this.handleRequest(req, res));

    // Start HTTP server
    httpServer.listen(this.port, () => {
      logger.info(`🚀 MCP Streamable HTTP Server listening on port ${this.port}`);
      logger.info(`📡 MCP endpoint: http://localhost:${this.port}/mcp`);
      logger.info(`📚 API info: http://localhost:${this.port}/`);
      logger.info('\nTest with curl:');
      logger.info(`  # List tools`);
      logger.info(`  curl -X POST http://localhost:${this.port}/mcp \\`);
      logger.info(`    -H "Content-Type: application/json" \\`);
      logger.info(`    -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}'`);
      logger.info(`\n  # Get stats`);
      logger.info(`  curl -X POST http://localhost:${this.port}/mcp \\`);
      logger.info(`    -H "Content-Type: application/json" \\`);
      logger.info(`    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"stats","arguments":{}},"id":2}'`);
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
      logger.info('Shutting down MCP Streamable HTTP server...');
      await this.mcpServer.close();
      this.db.close();
      httpServer.close();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Shutting down MCP Streamable HTTP server...');
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
MCP Feature Store - Streamable HTTP Server

This server implements the MCP protocol over standard HTTP with JSON-RPC,
providing a streamable interface for feature extraction and management.

Usage:
  npm run mcp-streamable [port]     Start server on specified port (default: 3000)
  npm run mcp-streamable:dev [port] Start in development mode with auto-reload
  
Examples:
  npm run mcp-streamable            Start on default port 3000
  npm run mcp-streamable 8080       Start on port 8080
  PORT=4000 npm run mcp-streamable  Start on port 4000 via env variable

MCP Endpoint:
  http://localhost:${port}/mcp

API Documentation:
  http://localhost:${port}/

Testing:
  # List available tools
  curl -X POST http://localhost:${port}/mcp \\
    -H "Content-Type: application/json" \\
    -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}'

  # Get database statistics
  curl -X POST http://localhost:${port}/mcp \\
    -H "Content-Type: application/json" \\
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"stats","arguments":{}},"id":2}'

  # Extract features from an image
  curl -X POST http://localhost:${port}/mcp \\
    -H "Content-Type: application/json" \\
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"extract","arguments":{"url":"/path/to/image.jpg"}},"id":3}'

  # Query stored features
  curl -X POST http://localhost:${port}/mcp \\
    -H "Content-Type: application/json" \\
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"query","arguments":{"featureKeys":["image.dimensions"]}},"id":4}'

Environment Variables:
  PORT           Server port (default: 3000)
  DATABASE_PATH  Path to SQLite database
  LOG_LEVEL      Logging level (info, debug, error)

Integration:
  This server can be used with any MCP-compatible client that supports
  HTTP transport. Configure your client to connect to:
  http://localhost:${port}/mcp
`);
  process.exit(0);
}

// Start server
const server = new MCPStreamableServer(port);
server.start().catch(error => {
  logger.error('Failed to start server:', error);
  process.exit(1);
});