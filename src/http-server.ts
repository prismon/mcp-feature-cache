#!/usr/bin/env node

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { parse } from 'url';
import { FeatureDatabase } from './db/database.js';
import { FeatureOrchestrator } from './core/orchestrator.js';
import { createLogger } from './utils/logger.js';
import { 
  ExtractToolSchema,
  QueryToolSchema,
  RegisterExtractorSchema,
  ListExtractorsSchema,
  UpdateTTLSchema
} from './types/schemas.js';

const logger = createLogger('http-server');

interface HttpRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: any;
}

class FeatureStoreHttpServer {
  private db: FeatureDatabase;
  private orchestrator: FeatureOrchestrator;
  private port: number;

  constructor(port: number = 3000) {
    this.port = port;
    this.db = new FeatureDatabase();
    this.orchestrator = new FeatureOrchestrator(this.db);
  }

  private async parseBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (e) {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  private sendJson(res: ServerResponse, status: number, data: any) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(data));
  }

  private sendSSE(res: ServerResponse) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    
    // Send initial connection message
    res.write('event: connected\ndata: {"status": "connected"}\n\n');
    
    return {
      send: (event: string, data: any) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      },
      close: () => {
        res.end();
      }
    };
  }

  private async handleExtract(req: IncomingMessage, res: ServerResponse, body: any) {
    try {
      const params = ExtractToolSchema.parse(body);
      
      if (params.stream) {
        // SSE streaming mode
        const sse = this.sendSSE(res);
        
        try {
          for await (const update of this.orchestrator.extractFeaturesStream(params.url, {
            extractors: params.extractors,
            ttl: params.ttl,
            force: params.force
          })) {
            sse.send('feature_update', update);
          }
          sse.send('complete', { status: 'success' });
        } catch (error: any) {
          sse.send('error', { error: error.message });
        } finally {
          sse.close();
        }
      } else {
        // Regular JSON response
        const features = await this.orchestrator.extractFeatures(params.url, {
          extractors: params.extractors,
          ttl: params.ttl,
          force: params.force
        });
        this.sendJson(res, 200, { features });
      }
    } catch (error: any) {
      this.sendJson(res, 400, { error: error.message });
    }
  }

  private async handleQuery(req: IncomingMessage, res: ServerResponse, body: any) {
    try {
      const params = QueryToolSchema.parse(body);
      const features = await this.db.queryFeatures(params);
      this.sendJson(res, 200, { features });
    } catch (error: any) {
      this.sendJson(res, 400, { error: error.message });
    }
  }

  private async handleRegisterExtractor(req: IncomingMessage, res: ServerResponse, body: any) {
    try {
      const params = RegisterExtractorSchema.parse(body);
      await this.db.registerExtractor({
        toolName: params.toolName,
        serverUrl: params.serverUrl,
        capabilities: params.capabilities,
        featureKeys: params.featureKeys,
        priority: params.priority || 100,
        enabled: true
      });
      this.sendJson(res, 200, { message: `Extractor ${params.toolName} registered successfully` });
    } catch (error: any) {
      this.sendJson(res, 400, { error: error.message });
    }
  }

  private async handleListExtractors(req: IncomingMessage, res: ServerResponse, query: Record<string, string>) {
    try {
      const params = ListExtractorsSchema.parse({
        enabled: query.enabled === 'true' ? true : query.enabled === 'false' ? false : undefined,
        capability: query.capability
      });
      const extractors = await this.db.getExtractors(params);
      this.sendJson(res, 200, { extractors });
    } catch (error: any) {
      this.sendJson(res, 400, { error: error.message });
    }
  }

  private async handleUpdateTTL(req: IncomingMessage, res: ServerResponse, body: any) {
    try {
      const params = UpdateTTLSchema.parse(body);
      await this.db.updateTTL(params.url, params.featureKey, params.ttl);
      this.sendJson(res, 200, { message: `TTL updated for ${params.url}/${params.featureKey}` });
    } catch (error: any) {
      this.sendJson(res, 400, { error: error.message });
    }
  }

  private async handleStats(req: IncomingMessage, res: ServerResponse) {
    try {
      const stats = await this.db.getStats();
      this.sendJson(res, 200, stats);
    } catch (error: any) {
      this.sendJson(res, 500, { error: error.message });
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse) {
    const parsedUrl = parse(req.url || '', true);
    const path = parsedUrl.pathname || '/';
    const query = parsedUrl.query as Record<string, string>;
    
    logger.info(`${req.method} ${path}`);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }

    // API documentation
    if (path === '/' && req.method === 'GET') {
      this.sendJson(res, 200, {
        name: 'MCP Feature Store HTTP API',
        version: '1.0.0',
        endpoints: [
          {
            path: '/extract',
            method: 'POST',
            description: 'Extract features from a resource',
            body: {
              url: 'string (required)',
              extractors: 'string[] (optional)',
              ttl: 'number (optional)',
              stream: 'boolean (optional) - Enable SSE streaming',
              force: 'boolean (optional)'
            }
          },
          {
            path: '/query',
            method: 'POST',
            description: 'Query stored features',
            body: {
              url: 'string (optional)',
              featureKeys: 'string[] (optional)',
              extractors: 'string[] (optional)',
              includeExpired: 'boolean (optional)'
            }
          },
          {
            path: '/extractors',
            method: 'GET',
            description: 'List registered extractors',
            query: {
              enabled: 'boolean (optional)',
              capability: 'string (optional)'
            }
          },
          {
            path: '/extractors',
            method: 'POST',
            description: 'Register a new extractor'
          },
          {
            path: '/ttl',
            method: 'POST',
            description: 'Update feature TTL'
          },
          {
            path: '/stats',
            method: 'GET',
            description: 'Get database statistics'
          },
          {
            path: '/stream/{url}',
            method: 'GET',
            description: 'Stream feature extraction via SSE'
          }
        ]
      });
      return;
    }

    try {
      // Parse body for POST requests
      let body = {};
      if (req.method === 'POST') {
        body = await this.parseBody(req);
      }

      // Route requests
      switch (path) {
        case '/extract':
          if (req.method === 'POST') {
            await this.handleExtract(req, res, body);
          } else {
            this.sendJson(res, 405, { error: 'Method not allowed' });
          }
          break;

        case '/query':
          if (req.method === 'POST') {
            await this.handleQuery(req, res, body);
          } else {
            this.sendJson(res, 405, { error: 'Method not allowed' });
          }
          break;

        case '/extractors':
          if (req.method === 'GET') {
            await this.handleListExtractors(req, res, query);
          } else if (req.method === 'POST') {
            await this.handleRegisterExtractor(req, res, body);
          } else {
            this.sendJson(res, 405, { error: 'Method not allowed' });
          }
          break;

        case '/ttl':
          if (req.method === 'POST') {
            await this.handleUpdateTTL(req, res, body);
          } else {
            this.sendJson(res, 405, { error: 'Method not allowed' });
          }
          break;

        case '/stats':
          if (req.method === 'GET') {
            await this.handleStats(req, res);
          } else {
            this.sendJson(res, 405, { error: 'Method not allowed' });
          }
          break;

        default:
          // Handle /stream/* for GET streaming
          if (path.startsWith('/stream/') && req.method === 'GET') {
            const url = decodeURIComponent(path.substring(8));
            await this.handleExtract(req, res, { url, stream: true });
          } else {
            this.sendJson(res, 404, { error: 'Not found' });
          }
      }
    } catch (error: any) {
      logger.error('Request error:', error);
      this.sendJson(res, 500, { error: 'Internal server error' });
    }
  }

  async start() {
    const server = createServer((req, res) => this.handleRequest(req, res));
    
    server.listen(this.port, () => {
      logger.info(`🚀 HTTP server listening on port ${this.port}`);
      logger.info(`📡 SSE streaming available at /extract with stream=true`);
      logger.info(`📚 API documentation at http://localhost:${this.port}/`);
    });

    // Cleanup task
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
    process.on('SIGINT', () => {
      logger.info('Shutting down HTTP server...');
      server.close();
      this.db.close();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      logger.info('Shutting down HTTP server...');
      server.close();
      this.db.close();
      process.exit(0);
    });
  }
}

// Parse command line arguments
const port = parseInt(process.argv[2]) || parseInt(process.env.PORT || '3000');

if (process.argv.includes('--help')) {
  console.log(`
MCP Feature Store HTTP Server

Usage:
  npm run http [port]           Start HTTP server on specified port (default: 3000)
  npm run http:dev [port]       Start in development mode with auto-reload
  
Examples:
  npm run http                  Start on default port 3000
  npm run http 8080             Start on port 8080
  PORT=4000 npm run http        Start on port 4000 via env variable

API Endpoints:
  GET  /                        API documentation
  POST /extract                 Extract features (supports SSE with stream=true)
  POST /query                   Query stored features
  GET  /extractors              List registered extractors
  POST /extractors              Register new extractor
  POST /ttl                     Update feature TTL
  GET  /stats                   Get database statistics
  GET  /stream/{url}            Stream extraction via SSE

SSE Streaming:
  POST /extract with body:
    {
      "url": "path/to/resource",
      "stream": true
    }
  
  Or use GET:
    /stream/{encoded-url}

Environment Variables:
  PORT                          Server port (default: 3000)
  DATABASE_PATH                 Path to SQLite database
  LOG_LEVEL                     Logging level (info, debug, error)
`);
  process.exit(0);
}

// Start server
const server = new FeatureStoreHttpServer(port);
server.start().catch(error => {
  logger.error('Failed to start server:', error);
  process.exit(1);
});