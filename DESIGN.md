# MCP Feature Store Service - Design Document

## Overview

The MCP Feature Store is a streamable Model Context Protocol service that extracts, stores, and manages features from various content sources (files and URLs). It orchestrates feature extraction through MCP tools, providing a flexible pipeline where feature generators are themselves MCP services.

## Architecture

### Core Components

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   MCP Client    │────▶│  MCP Server      │────▶│  Feature Store  │
│   (Claude/AI)   │     │  (Orchestrator)  │     │   (SQLite)     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │  Feature Pipeline   │
                    │   (MCP Client)      │
                    └─────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
┌───────────────┐    ┌───────────────┐     ┌──────────────┐
│MCP Text Tool  │    │MCP Image Tool │     │MCP Embedding │
│   Service     │    │   Service     │     │   Service    │
└───────────────┘    └───────────────┘     └──────────────┘
```

### MCP Tool Architecture

Each feature extractor is an independent MCP service that can be invoked by the main Feature Store service:

```
Feature Store (MCP Server) ──MCP Protocol──▶ Feature Extractor (MCP Tool)
                          ◀──────────────── Feature Values
```

## Data Model

### Feature Storage Schema

```typescript
interface Feature {
  id: string;                    // UUID v4
  resourceUrl: string;            // File path or URL
  featureKey: string;             // Strongly typed feature name
  value: string;                  // Base64 encoded for binary data
  valueType: FeatureType;         // text | number | binary | embedding
  generatedAt: number;            // Unix timestamp
  ttl: number;                    // Time to live in seconds
  expiresAt: number;              // Unix timestamp
  extractorTool: string;          // MCP tool that generated this feature
  metadata: Record<string, any>;  // Additional metadata
}

interface Resource {
  url: string;                    // Primary key
  type: ResourceType;             // file | url
  lastProcessed: number;          // Unix timestamp
  checksum?: string;              // SHA-256 for files
  size?: number;                  // File size in bytes
  mimeType?: string;              // Detected MIME type
}

interface ExtractorRegistry {
  toolName: string;               // MCP tool name
  serverUrl: string;              // MCP server URL
  capabilities: string[];         // Supported MIME types
  featureKeys: string[];          // Features this tool generates
  priority: number;               // Execution order
  enabled: boolean;
}
```

## SQLite Schema

```sql
-- Resources table
CREATE TABLE resources (
  url TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  last_processed INTEGER NOT NULL,
  checksum TEXT,
  size INTEGER,
  mime_type TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- Features table with TTL support
CREATE TABLE features (
  id TEXT PRIMARY KEY,
  resource_url TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  value TEXT NOT NULL,  -- Base64 encoded for binary
  value_type TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  ttl INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  extractor_tool TEXT NOT NULL,  -- MCP tool that generated this
  metadata TEXT,  -- JSON string
  FOREIGN KEY (resource_url) REFERENCES resources(url),
  UNIQUE(resource_url, feature_key)
);

-- Extractor registry for MCP tools
CREATE TABLE extractor_registry (
  tool_name TEXT PRIMARY KEY,
  server_url TEXT NOT NULL,
  capabilities TEXT NOT NULL,  -- JSON array of MIME types
  feature_keys TEXT NOT NULL,  -- JSON array of feature keys
  priority INTEGER DEFAULT 100,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- Indexes for performance
CREATE INDEX idx_features_resource ON features(resource_url);
CREATE INDEX idx_features_expires ON features(expires_at);
CREATE INDEX idx_features_key ON features(feature_key);
CREATE INDEX idx_features_extractor ON features(extractor_tool);
CREATE INDEX idx_resources_type ON resources(type);
CREATE INDEX idx_registry_enabled ON extractor_registry(enabled);
```

## MCP Feature Extractor Tools

### Standard MCP Tool Interface

Each feature extractor implements this MCP tool interface:

```typescript
// Tool: extract_features
interface ExtractFeaturesInput {
  resourceUrl: string;      // File path or URL
  content?: string;         // Base64 encoded content (optional)
  contentType: string;      // MIME type
  metadata?: Record<string, any>;
}

interface ExtractFeaturesOutput {
  features: Array<{
    key: string;           // Feature key (e.g., "text.summary")
    value: any;           // Feature value
    type: FeatureType;    // Value type
    ttl?: number;         // Suggested TTL
    metadata?: Record<string, any>;
  }>;
  extractorVersion: string;
  processingTime: number;
}
```

### Built-in MCP Extractor Services

#### 1. Text Content Extractor (mcp-text-extractor)
```typescript
// MCP Tool: extract_text_features
{
  name: "extract_text_features",
  description: "Extract features from text, markdown, and HTML content",
  inputSchema: {
    resourceUrl: "string",
    content: "string",
    contentType: "string"
  },
  features: [
    "text.content",        // Plain text
    "text.summary",        // AI-generated summary
    "text.keywords",       // Extracted keywords
    "text.language",       // Detected language
    "text.word_count",     // Word count
    "text.readability",    // Readability score
    "text.entities"        // Named entities
  ]
}
```

#### 2. Image Processor (mcp-image-extractor)
```typescript
// MCP Tool: extract_image_features
{
  name: "extract_image_features",
  description: "Generate thumbnails and extract image metadata",
  inputSchema: {
    resourceUrl: "string",
    content: "string",  // Base64 image
    contentType: "string"
  },
  features: [
    "image.thumbnail.small",     // 150x150 (base64)
    "image.thumbnail.medium",    // 400x400 (base64)
    "image.thumbnail.timeline",  // 1920x1080 (base64)
    "image.dimensions",          // {width, height}
    "image.format",             // Image format
    "image.dominant_colors",    // Color palette
    "image.exif"               // EXIF data
  ]
}
```

#### 3. Embedding Generator (mcp-embedding-service)
```typescript
// MCP Tool: generate_embeddings
{
  name: "generate_embeddings",
  description: "Generate vector embeddings for RAG",
  inputSchema: {
    resourceUrl: "string",
    content: "string",
    contentType: "string",
    model?: "string"  // Default: "text-embedding-3-small"
  },
  features: [
    "embedding.vector",      // Dense vector (base64)
    "embedding.model",       // Model used
    "embedding.dimensions",  // Vector dimensions
    "embedding.chunks"       // Chunked embeddings for long content
  ]
}
```

#### 4. Document Analyzer (mcp-document-analyzer)
```typescript
// MCP Tool: analyze_document
{
  name: "analyze_document",
  description: "Extract structured data from documents",
  inputSchema: {
    resourceUrl: "string",
    content: "string",
    contentType: "string"
  },
  features: [
    "document.structure",    // Document outline
    "document.tables",       // Extracted tables
    "document.links",        // Internal/external links
    "document.references",   // Citations/references
    "document.metadata"      // Author, date, etc.
  ]
}
```

## Feature Store Orchestrator

The main MCP Feature Store service acts as an orchestrator:

```typescript
class FeatureStoreOrchestrator {
  private mcpClients: Map<string, MCPClient>;
  private registry: ExtractorRegistry[];
  private db: Database;

  async extractFeatures(resourceUrl: string): Promise<Feature[]> {
    // 1. Determine resource type and load content
    const resource = await this.loadResource(resourceUrl);
    
    // 2. Find applicable MCP extractors from registry
    const extractors = await this.findExtractors(resource.mimeType);
    
    // 3. Call each MCP tool in parallel
    const extractionPromises = extractors.map(async (extractor) => {
      const client = await this.getMCPClient(extractor.serverUrl);
      
      return client.callTool(extractor.toolName, {
        resourceUrl,
        content: resource.content,
        contentType: resource.mimeType
      });
    });
    
    // 4. Collect and store features
    const results = await Promise.allSettled(extractionPromises);
    const features = this.processResults(results);
    
    // 5. Store in database with TTL
    await this.storeFeatures(resourceUrl, features);
    
    return features;
  }

  private async getMCPClient(serverUrl: string): Promise<MCPClient> {
    if (!this.mcpClients.has(serverUrl)) {
      const client = new MCPClient();
      await client.connect(serverUrl);
      this.mcpClients.set(serverUrl, client);
    }
    return this.mcpClients.get(serverUrl)!;
  }
}
```

## MCP Tool Registration

### Dynamic Tool Discovery

```typescript
interface ToolRegistration {
  // Register a new MCP extractor tool
  async registerExtractor(config: {
    toolName: string;
    serverUrl: string;
    capabilities: string[];  // MIME types
    featureKeys: string[];
    priority?: number;
  }): Promise<void>;

  // Discover tools from MCP server
  async discoverTools(serverUrl: string): Promise<{
    tools: Array<{
      name: string;
      features: string[];
      capabilities: string[];
    }>;
  }>;

  // Test tool connectivity
  async testExtractor(toolName: string): Promise<{
    success: boolean;
    responseTime: number;
    error?: string;
  }>;
}
```

### Configuration

```yaml
# mcp-feature-store.yaml
extractors:
  # Built-in extractors
  - name: extract_text_features
    server: stdio://./extractors/text-extractor
    enabled: true
    priority: 100
    
  - name: extract_image_features
    server: stdio://./extractors/image-extractor
    enabled: true
    priority: 100
    
  - name: generate_embeddings
    server: http://localhost:3001/mcp
    enabled: true
    priority: 200
    config:
      model: text-embedding-3-small
      
  # External extractors
  - name: custom_pdf_analyzer
    server: http://pdf-service:3002/mcp
    enabled: true
    priority: 150
    capabilities:
      - application/pdf
```

## Streaming Implementation

### Stream Processing Pipeline

```typescript
interface StreamProcessor {
  async *processStream(
    resourceUrl: string,
    extractors: string[]
  ): AsyncGenerator<StreamUpdate> {
    // 1. Start extraction tasks
    const tasks = this.startExtractions(resourceUrl, extractors);
    
    // 2. Stream progress updates
    for (const task of tasks) {
      yield {
        type: 'extraction_started',
        extractor: task.extractor,
        resourceUrl
      };
    }
    
    // 3. Stream feature updates as they complete
    for await (const result of this.streamResults(tasks)) {
      yield {
        type: 'feature_extracted',
        extractor: result.extractor,
        features: result.features,
        resourceUrl
      };
      
      // Store features immediately
      await this.storeFeatures(result.features);
    }
    
    yield {
      type: 'extraction_complete',
      resourceUrl
    };
  }
}
```

## MCP Server Implementation

### Main Feature Store Tools

```typescript
// Tool 1: Extract features using registered MCP extractors
{
  name: "extract",
  description: "Extract features from a resource using MCP tools",
  inputSchema: {
    url: { type: "string", description: "File path or URL" },
    extractors: { 
      type: "array", 
      items: { type: "string" },
      description: "Specific extractors to use (optional)"
    },
    ttl: { type: "number", description: "TTL in seconds" },
    stream: { type: "boolean", description: "Enable streaming" }
  }
}

// Tool 2: Query stored features
{
  name: "query",
  description: "Query features from the store",
  inputSchema: {
    url: { type: "string", description: "Resource URL (optional)" },
    featureKeys: { 
      type: "array",
      items: { type: "string" },
      description: "Feature keys to retrieve"
    },
    extractors: {
      type: "array",
      items: { type: "string" },
      description: "Filter by extractor tools"
    }
  }
}

// Tool 3: Register MCP extractor
{
  name: "register_extractor",
  description: "Register a new MCP feature extractor",
  inputSchema: {
    toolName: { type: "string" },
    serverUrl: { type: "string" },
    capabilities: { type: "array", items: { type: "string" } },
    featureKeys: { type: "array", items: { type: "string" } }
  }
}

// Tool 4: List available extractors
{
  name: "list_extractors",
  description: "List all registered MCP extractors",
  inputSchema: {}
}
```

## Error Handling

```typescript
class FeatureStoreError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public extractor?: string,
    public context?: any
  ) {
    super(message);
  }
}

enum ErrorCode {
  EXTRACTOR_UNAVAILABLE = 'EXTRACTOR_UNAVAILABLE',
  EXTRACTOR_TIMEOUT = 'EXTRACTOR_TIMEOUT',
  EXTRACTION_FAILED = 'EXTRACTION_FAILED',
  MCP_CONNECTION_FAILED = 'MCP_CONNECTION_FAILED',
  INVALID_TOOL_RESPONSE = 'INVALID_TOOL_RESPONSE',
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  DATABASE_ERROR = 'DATABASE_ERROR'
}

// Graceful degradation
class ExtractionOrchestrator {
  async extractWithFallback(
    resourceUrl: string,
    extractors: ExtractorConfig[]
  ): Promise<Feature[]> {
    const results: Feature[] = [];
    const errors: Error[] = [];
    
    for (const extractor of extractors) {
      try {
        const features = await this.callExtractor(extractor, resourceUrl);
        results.push(...features);
      } catch (error) {
        errors.push(error);
        // Continue with next extractor
        console.warn(`Extractor ${extractor.toolName} failed:`, error);
      }
    }
    
    if (results.length === 0 && errors.length > 0) {
      throw new AggregateError(errors, 'All extractors failed');
    }
    
    return results;
  }
}
```

## Deployment Architecture

### Microservices Deployment

```yaml
# docker-compose.yml
version: '3.8'

services:
  # Main Feature Store Orchestrator
  feature-store:
    image: mcp-feature-store:latest
    ports:
      - "3000:3000"
    volumes:
      - ./data:/data
    environment:
      - DATABASE_PATH=/data/features.db
      
  # Text Extractor Service
  text-extractor:
    image: mcp-text-extractor:latest
    ports:
      - "3001:3001"
      
  # Image Extractor Service  
  image-extractor:
    image: mcp-image-extractor:latest
    ports:
      - "3002:3002"
      
  # Embedding Service
  embedding-service:
    image: mcp-embedding-service:latest
    ports:
      - "3003:3003"
    environment:
      - OPENAI_API_KEY=${OPENAI_API_KEY}
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mcp-feature-store
spec:
  replicas: 3
  selector:
    matchLabels:
      app: feature-store
  template:
    metadata:
      labels:
        app: feature-store
    spec:
      containers:
      - name: orchestrator
        image: mcp-feature-store:latest
        ports:
        - containerPort: 3000
      - name: text-extractor
        image: mcp-text-extractor:latest
        ports:
        - containerPort: 3001
```

## Example Usage

### Client Integration

```typescript
// Initialize MCP client
const client = new MCPClient();
await client.connect('mcp-feature-store');

// Register a custom extractor
await client.callTool('register_extractor', {
  toolName: 'extract_sentiment',
  serverUrl: 'http://sentiment-service:4000/mcp',
  capabilities: ['text/plain', 'text/html'],
  featureKeys: ['sentiment.score', 'sentiment.label']
});

// Extract features using multiple MCP tools
const features = await client.callTool('extract', {
  url: 'https://example.com/article.html',
  extractors: ['extract_text_features', 'generate_embeddings', 'extract_sentiment'],
  ttl: 3600,
  stream: true
});

// Stream feature updates
for await (const update of features) {
  console.log(`Extracted ${update.features.length} features from ${update.extractor}`);
}

// Query specific features
const embeddings = await client.callTool('query', {
  url: 'https://example.com/article.html',
  featureKeys: ['embedding.vector', 'text.summary']
});
```

### Creating Custom MCP Extractors

```typescript
// custom-extractor.ts
import { MCPServer } from '@modelcontextprotocol/sdk';

const server = new MCPServer({
  name: 'custom-extractor',
  version: '1.0.0'
});

server.addTool({
  name: 'extract_custom_features',
  description: 'Extract custom features',
  inputSchema: {
    type: 'object',
    properties: {
      resourceUrl: { type: 'string' },
      content: { type: 'string' },
      contentType: { type: 'string' }
    }
  },
  handler: async (args) => {
    // Custom extraction logic
    const features = await processContent(args.content);
    
    return {
      features: [
        {
          key: 'custom.feature1',
          value: features.feature1,
          type: 'text',
          ttl: 3600
        }
      ],
      extractorVersion: '1.0.0',
      processingTime: Date.now()
    };
  }
});

await server.start();
```

## Performance Optimizations

### Parallel Extraction

```typescript
class ParallelExtractor {
  async extractAll(
    resourceUrl: string,
    extractors: string[]
  ): Promise<FeatureSet> {
    // Create extraction tasks
    const tasks = extractors.map(extractor => ({
      extractor,
      promise: this.callMCPTool(extractor, resourceUrl)
    }));
    
    // Execute in parallel with concurrency limit
    const results = await pLimit(5)(tasks.map(t => t.promise));
    
    return this.mergeResults(results);
  }
}
```

### Caching Strategy

```typescript
interface CacheStrategy {
  // L1: In-memory cache for hot features
  memoryCache: LRUCache<string, Feature>;
  
  // L2: SQLite for persistent storage
  database: Database;
  
  // L3: Optional Redis for distributed cache
  redis?: RedisClient;
  
  async get(key: string): Promise<Feature | null> {
    // Check L1
    if (this.memoryCache.has(key)) {
      return this.memoryCache.get(key);
    }
    
    // Check L2
    const feature = await this.database.getFeature(key);
    if (feature && !this.isExpired(feature)) {
      this.memoryCache.set(key, feature);
      return feature;
    }
    
    return null;
  }
}
```

## Monitoring & Observability

```typescript
interface Metrics {
  // Extraction metrics
  extractionRequests: Counter;
  extractionDuration: Histogram;
  extractorErrors: Counter;
  
  // MCP tool metrics
  toolCallDuration: Histogram;
  toolAvailability: Gauge;
  
  // Feature metrics
  featuresGenerated: Counter;
  featureSize: Histogram;
  
  // System metrics
  databaseSize: Gauge;
  cacheHitRate: Gauge;
}

// OpenTelemetry integration
import { trace, metrics } from '@opentelemetry/api';

const tracer = trace.getTracer('mcp-feature-store');
const meter = metrics.getMeter('mcp-feature-store');

const extractionCounter = meter.createCounter('extractions_total');
const extractionHistogram = meter.createHistogram('extraction_duration_ms');
```

## Future Enhancements

1. **Federated Extraction**: Distribute extraction across multiple MCP servers
2. **Smart Routing**: ML-based routing to optimal extractors
3. **Feature Composition**: Combine features from multiple extractors
4. **Incremental Extraction**: Process only changed content
5. **Feature Marketplace**: Registry for community MCP extractors
6. **GraphQL Federation**: Expose features via federated GraphQL
7. **Event Sourcing**: Track all feature changes over time
8. **A/B Testing**: Compare different extractor versions
9. **Cost Optimization**: Track and optimize API usage costs
10. **Feature Lineage**: Track dependencies between features