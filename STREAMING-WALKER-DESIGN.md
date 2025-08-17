# Streaming Directory Walker Design Document

## Executive Summary

This document outlines the design for a high-performance, streaming directory walker that provides real-time updates to frontend applications while extracting features from filesystem resources. The system uses depth-first search (DFS) for predictable traversal order, concurrent worker threads for extraction, and Server-Sent Events (SSE) for streaming updates.

## Core Requirements

### 1. Traversal Strategy
- **Depth-First Search (DFS)** for predictable, memory-efficient traversal
- Enables frontend to animate folder expansion naturally
- Maintains parent-child relationships for tree visualization

### 2. Real-Time Streaming
- Stream discovery events as directories and files are found
- Stream extraction progress and completion events
- Support for cancellation and pause/resume operations

### 3. Concurrent Processing
- Off-main-thread execution using Worker Threads
- Configurable worker pool size
- Queue-based work distribution

### 4. Safety & Performance
- Skip `.` and `..` entries
- Respect `.gitignore` patterns
- Handle symbolic links safely (no infinite loops)
- Configurable depth limits

## Architecture Overview

```
┌─────────────────┐     SSE Stream      ┌──────────────┐
│   Frontend UI   │◄────────────────────│  API Server  │
└─────────────────┘                     └──────┬───────┘
                                                │
                                    ┌───────────▼────────────┐
                                    │  Stream Coordinator    │
                                    └───────────┬────────────┘
                                                │
                    ┌───────────────────────────┼───────────────────────────┐
                    │                           │                           │
          ┌─────────▼────────┐      ┌──────────▼────────┐      ┌───────────▼────────┐
          │  Walker Thread 1  │      │  Walker Thread 2  │      │  Walker Thread N   │
          └─────────┬────────┘      └──────────┬────────┘      └───────────┬────────┘
                    │                           │                           │
          ┌─────────▼────────┐      ┌──────────▼────────┐      ┌───────────▼────────┐
          │ Extractor Pool 1  │      │ Extractor Pool 2  │      │ Extractor Pool N   │
          └──────────────────┘      └───────────────────┘      └────────────────────┘
```

## Event Stream Protocol

### Event Types

```typescript
enum WalkEventType {
  // Resource events (creates/updates resources table)
  RESOURCE_DISCOVERED = 'resource_discovered',  // New file or directory found
  
  // Feature events (updates features table)
  FEATURE_UPDATED = 'feature_updated',          // Feature value changed (including sizes)
  
  // Extraction events
  EXTRACTION_START = 'extraction_start',
  EXTRACTION_PROGRESS = 'extraction_progress',
  EXTRACTION_COMPLETE = 'extraction_complete',
  EXTRACTION_ERROR = 'extraction_error',
  
  // System events
  WALK_START = 'walk_start',
  WALK_COMPLETE = 'walk_complete',
  WALK_ERROR = 'walk_error'
}

interface ResourceInfo {
  url: string;                // file:// URL stored in resources.url
  type: 'file' | 'directory'; // Matches resources.type
  size?: number;              // For files, stored in resources.size
  mimeType?: string;          // Stored in resources.mime_type
  checksum?: string;          // Stored in resources.checksum
  lastProcessed: number;      // Stored in resources.last_processed
}

interface FeatureUpdate {
  resourceUrl: string;        // References resources.url
  featureKey: string;         // e.g., 'directory.total_size', 'directory.file_count'
  value: string;              // New value (stored as string in features.value)
  valueType: 'number' | 'json' | 'text';  // features.value_type
  previousValue?: string;     // For showing deltas in UI
  affectedBy?: string;        // Path that triggered this update (for propagation)
}

interface WalkEvent {
  id: string;
  type: WalkEventType;
  timestamp: number;
  path: string;               // File path (converted to file:// URL for storage)
  parentPath?: string;
  depth: number;
  
  // For RESOURCE_DISCOVERED events
  resource?: ResourceInfo;
  
  // For FEATURE_UPDATED events
  feature?: FeatureUpdate;
  
  // For extraction events
  extraction?: {
    mode: 'minimal' | 'standard' | 'maximal';
    features?: string[];      // List of feature keys extracted
    progress?: number;
    error?: string;
  };
}
```

### SSE Stream Format (Leveraging Existing MCP Infrastructure)

```
event: resource_discovered
data: {"id":"uuid","type":"resource_discovered","path":"/src/components","resource":{"url":"file:///src/components","type":"directory","lastProcessed":1755372925}}

event: feature_updated
data: {"id":"uuid","type":"feature_updated","path":"/src/components","feature":{"resourceUrl":"file:///src/components","featureKey":"directory.file_count","value":"0","valueType":"number"}}

event: resource_discovered
data: {"id":"uuid","type":"resource_discovered","path":"/src/components/App.tsx","resource":{"url":"file:///src/components/App.tsx","type":"file","size":2048,"mimeType":"text/typescript"}}

event: feature_updated
data: {"id":"uuid","type":"feature_updated","path":"/src/components","feature":{"resourceUrl":"file:///src/components","featureKey":"directory.total_size","value":"2048","valueType":"number","previousValue":"0","affectedBy":"/src/components/App.tsx"}}

event: feature_updated
data: {"id":"uuid","type":"feature_updated","path":"/src","feature":{"resourceUrl":"file:///src","featureKey":"directory.total_size","value":"2048","valueType":"number","affectedBy":"/src/components/App.tsx"}}

event: extraction_complete
data: {"id":"uuid","type":"extraction_complete","path":"/src/components/App.tsx","extraction":{"features":["text.content","text.word_count","text.line_count"]}}
```

### Integration with Existing MCP Endpoints

```typescript
// Extend existing MCP server to support streaming walk
class MCPFeatureStore extends StreamableHTTPServerTransport {
  // Existing MCP tools
  @tool({ name: 'extract' })
  async extract(params: ExtractToolSchema) {
    if (params.stream) {
      // Return SSE stream endpoint URL
      return {
        streamUrl: `/api/walk-stream?path=${params.path}&mode=${params.mode}`,
        message: 'Streaming extraction started'
      };
    }
    // Regular extraction...
  }
  
  // New streaming endpoint integrated with existing Express server
  app.get('/api/walk-stream', async (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'  // Disable nginx buffering
    });
    
    const walker = new StreamingDFSWalker(db);
    const events = walker.walk(req.query.path, {
      mode: req.query.mode,
      propagateSize: true  // Enable size bubbling
    });
    
    for await (const event of events) {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  });
}
```

## DFS Walker Algorithm with Size Propagation

```typescript
class StreamingDFSWalker {
  private stack: WalkItem[] = [];
  private visited: Set<string> = new Set();
  private parentMap: Map<string, string> = new Map();
  private workerPool: WorkerPool;
  private db: FeatureDatabase;
  
  constructor(db: FeatureDatabase, workerPool: WorkerPool) {
    this.db = db;
    this.workerPool = workerPool;
  }
  
  async *walk(rootPath: string, options: WalkOptions): AsyncGenerator<WalkEvent> {
    // Resolve and validate root path
    const resolvedPath = await this.resolvePath(rootPath);
    const rootUrl = `file://${resolvedPath}`;
    
    // Initialize stack with root
    this.stack.push({
      path: resolvedPath,
      depth: 0,
      parent: null
    });
    
    // Create root resource in database
    await this.db.upsertResource({
      url: rootUrl,
      type: 'directory',
      lastProcessed: Math.floor(Date.now() / 1000),
      size: 0,
      mimeType: 'inode/directory'
    });
    
    // Initialize root directory features
    await this.db.storeFeatures(rootUrl, [
      { key: 'directory.total_size', value: '0', type: 'number', ttl: 86400, extractorTool: 'walker' },
      { key: 'directory.file_count', value: '0', type: 'number', ttl: 86400, extractorTool: 'walker' },
      { key: 'directory.subdirectory_count', value: '0', type: 'number', ttl: 86400, extractorTool: 'walker' }
    ]);
    
    // Emit walk start
    yield this.createEvent(WalkEventType.WALK_START, resolvedPath);
    
    while (this.stack.length > 0) {
      const current = this.stack.pop()!;
      
      // Skip if already visited (handles symlink loops)
      const realPath = await fs.realpath(current.path);
      if (this.visited.has(realPath)) continue;
      this.visited.add(realPath);
      
      // Track parent relationship
      if (current.parent) {
        this.parentMap.set(current.path, current.parent);
      }
      
      // Check depth limit
      if (current.depth >= options.maxDepth) continue;
      
      const stats = await fs.stat(current.path);
      
      if (stats.isDirectory()) {
        yield* this.processDirectory(current, stats, options);
      } else if (stats.isFile()) {
        yield* this.processFile(current, stats, options);
      }
    }
    
    // Wait for all extractions to complete
    await this.workerPool.drain();
    
    yield this.createEvent(WalkEventType.WALK_COMPLETE, rootPath);
  }
  
  private async* processDirectory(item: WalkItem, stats: fs.Stats, options: WalkOptions) {
    const dirUrl = `file://${item.path}`;
    
    // Create resource record in database
    await this.db.upsertResource({
      url: dirUrl,
      type: 'directory',
      lastProcessed: Math.floor(Date.now() / 1000),
      size: 0,
      mimeType: 'inode/directory'
    });
    
    // Initialize directory features in database
    await this.db.storeFeatures(dirUrl, [
      { key: 'directory.total_size', value: '0', type: 'number', ttl: 86400, extractorTool: 'walker' },
      { key: 'directory.file_count', value: '0', type: 'number', ttl: 86400, extractorTool: 'walker' },
      { key: 'directory.subdirectory_count', value: '0', type: 'number', ttl: 86400, extractorTool: 'walker' }
    ]);
    
    // Emit resource discovered event
    yield {
      id: uuidv4(),
      type: WalkEventType.RESOURCE_DISCOVERED,
      timestamp: Date.now(),
      path: item.path,
      parentPath: item.parent,
      depth: item.depth,
      resource: {
        url: dirUrl,
        type: 'directory',
        lastProcessed: Math.floor(Date.now() / 1000)
      }
    };
    
    // Read directory contents
    const entries = await fs.readdir(item.path, { withFileTypes: true });
    
    // Filter and sort entries for consistent DFS order
    const filtered = entries
      .filter(entry => !this.shouldSkip(entry, item.path, options))
      .sort((a, b) => {
        // Directories first, then files
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
    
    // Update directory count for immediate children
    const subdirCount = filtered.filter(e => e.isDirectory()).length;
    if (subdirCount > 0) {
      yield* this.propagateCountChange(item.path, 0, subdirCount);
    }
    
    // Add to stack in reverse order (for correct DFS traversal)
    for (let i = filtered.length - 1; i >= 0; i--) {
      const entry = filtered[i];
      const childPath = path.join(item.path, entry.name);
      
      this.stack.push({
        path: childPath,
        depth: item.depth + 1,
        parent: item.path
      });
    }
    
    // Queue directory for feature extraction
    if (options.extractDirectories) {
      this.workerPool.queue({
        type: 'directory',
        path: item.path,
        mode: options.extractionMode
      });
    }
  }
  
  private async* processFile(item: WalkItem, stats: fs.Stats, options: WalkOptions) {
    const fileUrl = `file://${item.path}`;
    const mimeType = await this.getMimeType(item.path);
    
    // Create resource record in database
    await this.db.upsertResource({
      url: fileUrl,
      type: 'file',
      lastProcessed: Math.floor(Date.now() / 1000),
      size: stats.size,
      mimeType,
      checksum: await this.calculateChecksum(item.path)
    });
    
    // Emit resource discovered event
    yield {
      id: uuidv4(),
      type: WalkEventType.RESOURCE_DISCOVERED,
      timestamp: Date.now(),
      path: item.path,
      parentPath: item.parent,
      depth: item.depth,
      resource: {
        url: fileUrl,
        type: 'file',
        size: stats.size,
        mimeType,
        lastProcessed: Math.floor(Date.now() / 1000)
      }
    };
    
    // Propagate size and count changes up the tree
    yield* this.propagateFeatureUpdates(item.path, stats.size, 1, 0);
    
    // Queue file for feature extraction
    if (options.extractFiles) {
      this.workerPool.queue({
        type: 'file',
        path: item.path,
        mode: options.extractionMode
      });
    }
  }
  
  private async* propagateFeatureUpdates(
    affectedPath: string, 
    sizeDelta: number, 
    fileCountDelta: number,
    dirCountDelta: number
  ) {
    let currentPath = this.parentMap.get(affectedPath);
    
    while (currentPath) {
      const parentUrl = `file://${currentPath}`;
      
      // Get current feature values from database
      const features = await this.db.queryFeatures({ url: parentUrl });
      const sizeFeature = features.find(f => f.featureKey === 'directory.total_size');
      const fileCountFeature = features.find(f => f.featureKey === 'directory.file_count');
      const dirCountFeature = features.find(f => f.featureKey === 'directory.subdirectory_count');
      
      // Calculate new values
      const newSize = (parseInt(sizeFeature?.value || '0') + sizeDelta).toString();
      const newFileCount = (parseInt(fileCountFeature?.value || '0') + fileCountDelta).toString();
      const newDirCount = (parseInt(dirCountFeature?.value || '0') + dirCountDelta).toString();
      
      // Update features in database
      await this.db.storeFeatures(parentUrl, [
        { key: 'directory.total_size', value: newSize, type: 'number', ttl: 86400, extractorTool: 'walker' },
        { key: 'directory.file_count', value: newFileCount, type: 'number', ttl: 86400, extractorTool: 'walker' },
        { key: 'directory.subdirectory_count', value: newDirCount, type: 'number', ttl: 86400, extractorTool: 'walker' }
      ]);
      
      // Emit feature update events
      if (sizeDelta !== 0) {
        yield {
          id: uuidv4(),
          type: WalkEventType.FEATURE_UPDATED,
          timestamp: Date.now(),
          path: currentPath,
          feature: {
            resourceUrl: parentUrl,
            featureKey: 'directory.total_size',
            value: newSize,
            valueType: 'number',
            previousValue: sizeFeature?.value,
            affectedBy: affectedPath
          }
        };
      }
      
      if (fileCountDelta !== 0) {
        yield {
          id: uuidv4(),
          type: WalkEventType.FEATURE_UPDATED,
          timestamp: Date.now(),
          path: currentPath,
          feature: {
            resourceUrl: parentUrl,
            featureKey: 'directory.file_count',
            value: newFileCount,
            valueType: 'number',
            previousValue: fileCountFeature?.value,
            affectedBy: affectedPath
          }
        };
      }
      
      // Move up the tree
      currentPath = this.parentMap.get(currentPath);
    }
  }
  
  private shouldSkip(entry: Dirent, parentPath: string, options: WalkOptions): boolean {
    const name = entry.name;
    
    // Always skip . and ..
    if (name === '.' || name === '..') return true;
    
    // Skip hidden files if configured
    if (options.skipHidden && name.startsWith('.')) return true;
    
    // Skip based on ignore patterns
    if (options.ignorePatterns) {
      const fullPath = path.join(parentPath, name);
      if (this.matchesIgnorePattern(fullPath, options.ignorePatterns)) {
        return true;
      }
    }
    
    // Skip large files
    if (entry.isFile() && options.maxFileSize) {
      const stats = fs.statSync(path.join(parentPath, name));
      if (stats.size > options.maxFileSize) return true;
    }
    
    return false;
  }
}
```

## Worker Thread Pool

```typescript
class ExtractorWorkerPool {
  private workers: Worker[] = [];
  private queue: Queue<ExtractionTask>;
  private activeJobs: Map<string, ExtractionJob>;
  
  constructor(options: WorkerPoolOptions) {
    this.queue = new Queue(options.queueSize);
    
    // Create worker threads
    for (let i = 0; i < options.workerCount; i++) {
      const worker = new Worker('./extractor-worker.js', {
        workerData: {
          workerId: i,
          dbPath: options.dbPath
        }
      });
      
      worker.on('message', this.handleWorkerMessage.bind(this));
      worker.on('error', this.handleWorkerError.bind(this));
      
      this.workers.push(worker);
    }
  }
  
  async queue(task: ExtractionTask): Promise<void> {
    await this.queue.push(task);
    this.processQueue();
  }
  
  private async processQueue() {
    while (!this.queue.isEmpty() && this.hasAvailableWorker()) {
      const task = await this.queue.pop();
      const worker = this.getAvailableWorker();
      
      const job: ExtractionJob = {
        id: uuidv4(),
        task,
        worker,
        startTime: Date.now()
      };
      
      this.activeJobs.set(job.id, job);
      
      worker.postMessage({
        type: 'EXTRACT',
        jobId: job.id,
        task
      });
    }
  }
}

// Worker thread implementation
// extractor-worker.js
const { parentPort, workerData } = require('worker_threads');
const { DirectFeatureOrchestrator } = require('./orchestrator');

const orchestrator = new DirectFeatureOrchestrator(workerData.dbPath);

parentPort.on('message', async (message) => {
  const { type, jobId, task } = message;
  
  if (type === 'EXTRACT') {
    try {
      // Send progress updates
      parentPort.postMessage({
        type: 'EXTRACTION_START',
        jobId,
        path: task.path
      });
      
      const features = await orchestrator.extractFeatures(task.path, {
        mode: task.mode,
        onProgress: (progress) => {
          parentPort.postMessage({
            type: 'EXTRACTION_PROGRESS',
            jobId,
            progress
          });
        }
      });
      
      parentPort.postMessage({
        type: 'EXTRACTION_COMPLETE',
        jobId,
        features: features.map(f => f.featureKey)
      });
    } catch (error) {
      parentPort.postMessage({
        type: 'EXTRACTION_ERROR',
        jobId,
        error: error.message
      });
    }
  }
});
```

## Configuration Options

```typescript
interface WalkOptions {
  // Traversal options
  maxDepth: number;              // Maximum depth to traverse (default: 10)
  followSymlinks: boolean;       // Follow symbolic links (default: false)
  skipHidden: boolean;           // Skip hidden files/dirs (default: true)
  
  // Filtering
  ignorePatterns: string[];      // Gitignore-style patterns
  includePatterns?: string[];    // Only include matching paths
  maxFileSize: number;           // Skip files larger than this (bytes)
  
  // Extraction
  extractionMode: 'minimal' | 'standard' | 'maximal';
  extractDirectories: boolean;   // Extract features from directories
  extractFiles: boolean;         // Extract features from files
  
  // Performance
  workerCount: number;           // Number of worker threads (default: 4)
  queueSize: number;             // Max items in queue (default: 1000)
  batchSize: number;             // Files to process per batch
  
  // Streaming
  eventBufferSize: number;       // Events to buffer before flush
  flushInterval: number;         // Ms between event flushes
}
```

## Recommended Open Source Libraries

### File Discovery & Walking

1. **[@nodelib/fs.walk](https://github.com/nodelib/nodelib/tree/master/packages/fs/fs.walk)**
   - Fast, modern filesystem walker
   - Supports streaming, async iterators
   - Built-in filtering and error handling
   ```typescript
   import * as fsWalk from '@nodelib/fs.walk';
   const stream = fsWalk.walkStream(path, options);
   ```

2. **[fast-glob](https://github.com/mrmlnc/fast-glob)**
   - High-performance glob matching
   - Supports streaming and ignore patterns
   - Great for filtered discovery
   ```typescript
   import fg from 'fast-glob';
   const stream = fg.stream(['**/*.ts'], { dot: true });
   ```

3. **[readdirp](https://github.com/paulmillr/readdirp)**
   - Recursive directory reading with streaming
   - Minimal dependencies
   - Simple API
   ```typescript
   import readdirp from 'readdirp';
   for await (const entry of readdirp(dir)) { }
   ```

4. **[node-ignore](https://github.com/kaelzhang/node-ignore)**
   - Gitignore-style path filtering
   - High performance
   ```typescript
   import ignore from 'ignore';
   const ig = ignore().add(patterns);
   ```

### Worker Thread Management

1. **[workerpool](https://github.com/josdejong/workerpool)**
   - Offload CPU intensive tasks
   - Dynamic worker pool sizing
   ```typescript
   import workerpool from 'workerpool';
   const pool = workerpool.pool('./worker.js');
   ```

2. **[piscina](https://github.com/piscinajs/piscina)**
   - Fast, modern worker thread pool
   - Built for Node.js
   ```typescript
   import Piscina from 'piscina';
   const pool = new Piscina({ filename: './worker.js' });
   ```

3. **[threads.js](https://github.com/andywer/threads.js)**
   - Type-safe workers with TypeScript
   - Promise-based API
   ```typescript
   import { spawn, Worker } from 'threads';
   const worker = await spawn(new Worker('./worker'));
   ```

### Streaming & Events

1. **[eventemitter3](https://github.com/primus/eventemitter3)**
   - High-performance EventEmitter
   - Browser compatible
   ```typescript
   import EventEmitter from 'eventemitter3';
   ```

2. **[p-queue](https://github.com/sindresorhus/p-queue)**
   - Promise queue with concurrency control
   - Priority support
   ```typescript
   import PQueue from 'p-queue';
   const queue = new PQueue({ concurrency: 2 });
   ```

## Performance Considerations

### Memory Management
- Use streaming/iterators instead of loading full directory listings
- Limit queue sizes to prevent memory exhaustion
- Clear visited set periodically for very large traversals

### I/O Optimization
- Batch database writes
- Use read-ahead caching for frequently accessed paths
- Implement exponential backoff for rate-limited filesystems

### CPU Optimization
- Balance worker count with available CPU cores
- Use native addons for compute-intensive extraction
- Implement extraction result caching

## Error Handling

```typescript
enum WalkErrorType {
  PERMISSION_DENIED = 'permission_denied',
  PATH_NOT_FOUND = 'path_not_found',
  SYMLINK_LOOP = 'symlink_loop',
  EXTRACTION_FAILED = 'extraction_failed',
  WORKER_CRASHED = 'worker_crashed'
}

class WalkError extends Error {
  constructor(
    public type: WalkErrorType,
    public path: string,
    public originalError?: Error
  ) {
    super(`Walk error at ${path}: ${type}`);
  }
}
```

## Frontend Integration Example

```typescript
// Frontend code with size tracking
class FileExplorer {
  private eventSource: EventSource;
  private treeData: Map<string, TreeNode>;
  private nodeAttributes: Map<string, NodeAttributes>;
  
  async startScan(rootPath: string, options: ScanOptions) {
    const params = new URLSearchParams({
      path: rootPath,
      mode: options.mode,
      stream: 'true'
    });
    
    // Use existing MCP endpoint with streaming support
    this.eventSource = new EventSource(`/api/walk-stream?${params}`);
    
    this.eventSource.addEventListener('resource_discovered', (e) => {
      const event: WalkEvent = JSON.parse(e.data);
      this.handleResourceDiscovered(event);
    });
    
    this.eventSource.addEventListener('feature_updated', (e) => {
      const event: WalkEvent = JSON.parse(e.data);
      this.handleFeatureUpdated(event);
    });
    
    this.eventSource.addEventListener('extraction_complete', (e) => {
      const event: WalkEvent = JSON.parse(e.data);
      this.updateNodeFeatures(event.path, event.extraction.features);
    });
  }
  
  private handleResourceDiscovered(event: WalkEvent) {
    // Create tree node from resource
    const node: TreeNode = {
      id: event.path,
      type: event.resource.type,
      name: path.basename(event.path),
      parent: event.parentPath,
      children: [],
      state: 'discovered',
      size: event.resource.size || 0,
      url: event.resource.url
    };
    
    // Add to tree with animation
    this.treeData.set(event.path, node);
    this.animateNode(node, 'slideIn');
    
    // Update display
    this.updateNodeDisplay(node);
  }
  
  private handleFeatureUpdated(event: WalkEvent) {
    const node = this.treeData.get(event.path);
    if (node && event.feature) {
      // Update node based on feature type
      switch (event.feature.featureKey) {
        case 'directory.total_size':
          node.size = parseInt(event.feature.value);
          this.animateSizeChange(node, event.feature);
          break;
        case 'directory.file_count':
          node.fileCount = parseInt(event.feature.value);
          break;
        case 'directory.subdirectory_count':
          node.dirCount = parseInt(event.feature.value);
          break;
      }
      
      // Update display
      this.updateNodeDisplay(node);
    }
  }
  
  private updateSizeDisplay(node: TreeNode) {
    const element = document.getElementById(node.id);
    if (element) {
      const sizeEl = element.querySelector('.size');
      sizeEl.textContent = this.formatSize(node.size);
      
      const countEl = element.querySelector('.count');
      countEl.textContent = `${node.fileCount} files, ${node.dirCount} folders`;
      
      // Pulse animation to show update
      element.classList.add('updated');
      setTimeout(() => element.classList.remove('updated'), 300);
    }
  }
  
  private animateSizeChange(node: TreeNode, delta: any) {
    const element = document.getElementById(node.id);
    if (element && delta) {
      // Show delta briefly
      const deltaEl = document.createElement('span');
      deltaEl.className = 'size-delta';
      deltaEl.textContent = `+${this.formatSize(delta.sizeDelta)}`;
      element.appendChild(deltaEl);
      
      // Fade out delta
      setTimeout(() => deltaEl.remove(), 1000);
    }
  }
}
```

## Testing Strategy

### Unit Tests
- Mock filesystem for deterministic testing
- Test skip patterns and depth limits
- Verify event ordering and completeness

### Integration Tests
- Test with real filesystem structures
- Verify worker thread coordination
- Test error recovery and cancellation

### Performance Tests
- Benchmark against large directory trees
- Measure memory usage over time
- Test concurrent extraction throughput

## Security Considerations

1. **Path Traversal Protection**
   - Validate and sanitize all input paths
   - Resolve to absolute paths and check boundaries
   - Prevent access outside allowed directories

2. **Resource Limits**
   - Enforce maximum traversal depth
   - Limit total files processed
   - Implement timeouts for stuck operations

3. **Worker Isolation**
   - Run workers with restricted permissions
   - Limit worker memory usage
   - Implement worker health checks

## Migration Plan

1. **Phase 1**: Implement streaming walker alongside existing code
2. **Phase 2**: Add worker pool for extraction
3. **Phase 3**: Integrate SSE streaming endpoints
4. **Phase 4**: Update frontend to use streaming API
5. **Phase 5**: Deprecate and remove old synchronous walker

## Conclusion

This streaming directory walker design provides:
- Real-time feedback for responsive UIs
- Efficient DFS traversal for predictable ordering
- Concurrent extraction for improved throughput
- Robust error handling and safety checks
- Extensible architecture for future enhancements

The combination of modern Node.js features (Worker Threads, AsyncGenerators) with proven open-source libraries creates a performant and maintainable solution for large-scale filesystem traversal and feature extraction.