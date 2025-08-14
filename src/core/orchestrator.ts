import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import pLimit from 'p-limit';
import { spawn } from 'child_process';
import { FeatureDatabase } from '../db/database.js';
import { 
  Feature, 
  Resource, 
  ExtractorRegistry, 
  FeatureType, 
  ResourceType,
  StreamUpdate
} from '../types/index.js';
import { FeatureStoreError, ErrorCode } from '../types/errors.js';
import { createLogger } from '../utils/logger.js';
import { ResourceLoader } from './resource-loader.js';
import { v4 as uuidv4 } from 'uuid';

const logger = createLogger('orchestrator');

interface ExtractOptions {
  extractors?: string[];
  ttl?: number;
  force?: boolean;
}

interface MCPConnection {
  client: Client;
  transport: StdioClientTransport | WebSocketClientTransport;
  serverUrl: string;
}

export class FeatureOrchestrator {
  private mcpConnections: Map<string, MCPConnection> = new Map();
  private resourceLoader: ResourceLoader;
  private concurrencyLimit = pLimit(5); // Max 5 concurrent extractions

  constructor(private db: FeatureDatabase) {
    this.resourceLoader = new ResourceLoader();
  }

  async extractFeatures(
    resourceUrl: string, 
    options: ExtractOptions = {}
  ): Promise<Feature[]> {
    try {
      // Load resource
      const resource = await this.resourceLoader.load(resourceUrl);
      
      // Check if we should skip extraction
      if (!options.force) {
        const existingResource = await this.db.getResource(resourceUrl);
        if (existingResource && existingResource.checksum === resource.checksum) {
          const existingFeatures = await this.db.queryFeatures({ url: resourceUrl });
          if (existingFeatures.length > 0) {
            logger.info(`Using cached features for ${resourceUrl}`);
            return existingFeatures;
          }
        }
      }

      // Save/update resource
      await this.db.upsertResource({
        url: resourceUrl,
        type: resource.type,
        lastProcessed: Math.floor(Date.now() / 1000),
        checksum: resource.checksum,
        size: resource.size,
        mimeType: resource.mimeType
      });

      // Find applicable extractors
      const extractors = await this.findExtractors(resource.mimeType!, options.extractors);
      
      if (extractors.length === 0) {
        logger.warn(`No extractors found for ${resource.mimeType}`);
        return [];
      }

      // Execute extractors in parallel
      const extractionTasks = extractors.map(extractor => 
        this.concurrencyLimit(() => 
          this.callExtractor(extractor, resource, options.ttl)
        )
      );

      const results = await Promise.allSettled(extractionTasks);
      
      // Process results
      const allFeatures: Feature[] = [];
      const errors: Error[] = [];

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const extractor = extractors[i];

        if (result.status === 'fulfilled') {
          const features = result.value;
          allFeatures.push(...features);
          logger.info(`Extracted ${features.length} features using ${extractor.toolName}`);
        } else {
          const error = result.reason;
          errors.push(error);
          logger.error(`Extractor ${extractor.toolName} failed:`, error);
        }
      }

      // Store features in database
      if (allFeatures.length > 0) {
        const featuresToStore = allFeatures.map(f => ({
          key: f.featureKey,
          value: f.value,
          type: f.valueType,
          ttl: f.ttl,
          extractorTool: f.extractorTool,
          metadata: f.metadata
        }));

        await this.db.storeFeatures(resourceUrl, featuresToStore);
      }

      if (allFeatures.length === 0 && errors.length > 0) {
        throw new AggregateError(errors, 'All extractors failed');
      }

      return allFeatures;
    } catch (error: any) {
      logger.error(`Feature extraction failed for ${resourceUrl}:`, error);
      throw new FeatureStoreError(
        ErrorCode.EXTRACTION_FAILED,
        `Failed to extract features from ${resourceUrl}: ${error.message}`,
        undefined,
        { resourceUrl, error: error.message }
      );
    }
  }

  async *extractFeaturesStream(
    resourceUrl: string,
    options: ExtractOptions = {}
  ): AsyncGenerator<StreamUpdate> {
    const startTime = Date.now();
    
    yield {
      type: 'extraction_started',
      resourceUrl,
      timestamp: Date.now()
    };

    try {
      // Load resource
      const resource = await this.resourceLoader.load(resourceUrl);
      
      // Save/update resource
      await this.db.upsertResource({
        url: resourceUrl,
        type: resource.type,
        lastProcessed: Math.floor(Date.now() / 1000),
        checksum: resource.checksum,
        size: resource.size,
        mimeType: resource.mimeType
      });

      // Find applicable extractors
      const extractors = await this.findExtractors(resource.mimeType!, options.extractors);
      
      // Execute extractors and stream results
      for (const extractor of extractors) {
        yield {
          type: 'extraction_started',
          resourceUrl,
          extractor: extractor.toolName,
          timestamp: Date.now()
        };

        try {
          const features = await this.callExtractor(extractor, resource, options.ttl);
          
          // Store features
          const featuresToStore = features.map(f => ({
            key: f.featureKey,
            value: f.value,
            type: f.valueType,
            ttl: f.ttl,
            extractorTool: f.extractorTool,
            metadata: f.metadata
          }));
          
          await this.db.storeFeatures(resourceUrl, featuresToStore);
          
          yield {
            type: 'feature_extracted',
            resourceUrl,
            extractor: extractor.toolName,
            features: features.map(f => ({
              key: f.featureKey,
              value: f.value,
              type: f.valueType
            })),
            timestamp: Date.now()
          };
        } catch (error: any) {
          yield {
            type: 'extraction_error',
            resourceUrl,
            extractor: extractor.toolName,
            error: error.message,
            timestamp: Date.now()
          };
        }
      }

      yield {
        type: 'extraction_complete',
        resourceUrl,
        timestamp: Date.now(),
        progress: 100
      };
    } catch (error: any) {
      yield {
        type: 'extraction_error',
        resourceUrl,
        error: error.message,
        timestamp: Date.now()
      };
    }
  }

  private async findExtractors(
    mimeType: string,
    requestedExtractors?: string[]
  ): Promise<ExtractorRegistry[]> {
    let extractors = await this.db.getExtractors({
      enabled: true,
      capability: mimeType
    });

    // Filter by requested extractors if specified
    if (requestedExtractors && requestedExtractors.length > 0) {
      extractors = extractors.filter(e => 
        requestedExtractors.includes(e.toolName)
      );
    }

    return extractors;
  }

  private async callExtractor(
    extractor: ExtractorRegistry,
    resource: Resource & { content: Buffer },
    ttl?: number
  ): Promise<Feature[]> {
    try {
      const connection = await this.getMCPConnection(extractor.serverUrl);
      
      // Call the MCP tool
      const response = await connection.client.request({
        method: 'tools/call',
        params: {
          name: extractor.toolName,
          arguments: {
            resourceUrl: resource.url,
            content: resource.content.toString('base64'),
            contentType: resource.mimeType,
            metadata: {
              size: resource.size,
              checksum: resource.checksum
            }
          }
        }
      }) as any;

      // Convert response to Feature objects
      const features: Feature[] = response.features.map(f => ({
        id: uuidv4(),
        resourceUrl: resource.url,
        featureKey: f.key,
        value: this.encodeValue(f.value, f.type),
        valueType: f.type,
        generatedAt: Math.floor(Date.now() / 1000),
        ttl: f.ttl || ttl || 3600,
        expiresAt: Math.floor(Date.now() / 1000) + (f.ttl || ttl || 3600),
        extractorTool: extractor.toolName,
        metadata: f.metadata || {}
      }));

      return features;
    } catch (error: any) {
      throw new FeatureStoreError(
        ErrorCode.EXTRACTION_FAILED,
        `Extractor ${extractor.toolName} failed: ${error.message}`,
        extractor.toolName,
        { error: error.message }
      );
    }
  }

  private async getMCPConnection(serverUrl: string): Promise<MCPConnection> {
    if (!this.mcpConnections.has(serverUrl)) {
      const connection = await this.createMCPConnection(serverUrl);
      this.mcpConnections.set(serverUrl, connection);
    }
    
    return this.mcpConnections.get(serverUrl)!;
  }

  private async createMCPConnection(serverUrl: string): Promise<MCPConnection> {
    const client = new Client({
      name: 'mcp-feature-store-orchestrator',
      version: '1.0.0'
    }, {
      capabilities: {}
    });

    let transport: StdioClientTransport | WebSocketClientTransport;

    if (serverUrl.startsWith('stdio://')) {
      // Local stdio transport
      const command = serverUrl.replace('stdio://', '');
      const child = spawn('tsx', [command], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      });
      
      transport = new StdioClientTransport({
        command: 'tsx',
        args: [command]
      });
    } else if (serverUrl.startsWith('ws://') || serverUrl.startsWith('wss://')) {
      // WebSocket transport
      transport = new WebSocketClientTransport(new URL(serverUrl));
    } else {
      // HTTP transport (convert to WebSocket)
      const wsUrl = serverUrl.replace('http://', 'ws://').replace('https://', 'wss://');
      transport = new WebSocketClientTransport(new URL(wsUrl));
    }

    await client.connect(transport);

    return { client, transport, serverUrl };
  }

  private encodeValue(value: any, type: FeatureType): string {
    switch (type) {
      case FeatureType.BINARY:
      case FeatureType.EMBEDDING:
        return Buffer.isBuffer(value) ? value.toString('base64') : value;
      case FeatureType.JSON:
        return JSON.stringify(value);
      default:
        return String(value);
    }
  }

  async close(): Promise<void> {
    for (const [url, connection] of this.mcpConnections) {
      try {
        await connection.client.close();
        logger.info(`Closed MCP connection to ${url}`);
      } catch (error) {
        logger.error(`Error closing connection to ${url}:`, error);
      }
    }
    this.mcpConnections.clear();
  }
}