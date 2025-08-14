# HTTP Server with SSE Streaming

The MCP Feature Store includes a full HTTP API server with Server-Sent Events (SSE) support for real-time streaming.

## Starting the Server

### Basic Usage
```bash
# Start on default port 3000
npm run http

# Start on specific port
npm run http 8080

# Start with environment variable
PORT=4000 npm run http

# Development mode with auto-reload
npm run http:dev 8080
```

### Command Line Help
```bash
npm run http -- --help
```

## API Endpoints

### 📚 GET / - API Documentation
Returns complete API documentation in JSON format.

### 📤 POST /extract - Extract Features
Extract features from a resource with optional streaming.

**Request Body:**
```json
{
  "url": "/path/to/image.jpg",
  "extractors": ["image", "text"],  // optional
  "ttl": 3600,                       // optional
  "stream": true,                    // optional - enables SSE
  "force": false                     // optional - force re-extraction
}
```

**Regular Response (stream=false):**
```json
{
  "features": [
    {
      "id": "uuid",
      "featureKey": "image.thumbnail.small",
      "value": "base64...",
      "valueType": "binary"
    }
  ]
}
```

**SSE Response (stream=true):**
```
event: connected
data: {"status": "connected"}

event: feature_update
data: {"type": "extraction_started", "resourceUrl": "...", "extractor": "image"}

event: feature_update
data: {"type": "feature_extracted", "features": [...]}

event: complete
data: {"status": "success"}
```

### 🔍 POST /query - Query Features
Query stored features from the database.

**Request Body:**
```json
{
  "url": "/path/to/resource",         // optional
  "featureKeys": ["image.dimensions"], // optional
  "extractors": ["image"],            // optional
  "includeExpired": false              // optional
}
```

### 📊 GET /stats - Database Statistics
Returns current database statistics.

**Response:**
```json
{
  "totalResources": 10,
  "totalFeatures": 60,
  "expiredFeatures": 0,
  "activeExtractors": 3
}
```

### 🔧 GET /extractors - List Extractors
List all registered feature extractors.

**Query Parameters:**
- `enabled` - Filter by enabled status (true/false)
- `capability` - Filter by MIME type capability

### 🔧 POST /extractors - Register Extractor
Register a new MCP extractor tool.

**Request Body:**
```json
{
  "toolName": "custom-extractor",
  "serverUrl": "http://localhost:3001",
  "capabilities": ["text/plain", "text/html"],
  "featureKeys": ["custom.feature1"],
  "priority": 100
}
```

### ⏰ POST /ttl - Update TTL
Update the TTL for a specific feature.

**Request Body:**
```json
{
  "url": "/path/to/resource",
  "featureKey": "image.thumbnail.small",
  "ttl": 7200
}
```

### 📡 GET /stream/{url} - SSE Streaming
Stream feature extraction via Server-Sent Events.

**Example:**
```
GET /stream/https%3A%2F%2Fexample.com%2Fimage.jpg
```

## Client Examples

### Using curl

```bash
# Get stats
curl http://localhost:8080/stats

# Query features
curl -X POST http://localhost:8080/query \
  -H "Content-Type: application/json" \
  -d '{"featureKeys": ["image.dimensions"]}'

# Extract features (regular)
curl -X POST http://localhost:8080/extract \
  -H "Content-Type: application/json" \
  -d '{"url": "/path/to/image.jpg"}'

# Extract with streaming
curl -X POST http://localhost:8080/extract \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"url": "/path/to/image.jpg", "stream": true}'
```

### Using the HTTP Client Script

```bash
# Extract features
npx tsx scripts/http-client.ts extract /path/to/image.jpg

# Extract with streaming
npx tsx scripts/http-client.ts extract-stream /path/to/image.jpg

# Query features
npx tsx scripts/http-client.ts query "image.dimensions,image.format"

# Get statistics
npx tsx scripts/http-client.ts stats

# List extractors
npx tsx scripts/http-client.ts extractors
```

### JavaScript/TypeScript Client

```typescript
// Regular extraction
const response = await fetch('http://localhost:8080/extract', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: '/path/to/image.jpg',
    ttl: 3600
  })
});
const data = await response.json();

// SSE streaming
const response = await fetch('http://localhost:8080/extract', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: '/path/to/image.jpg',
    stream: true
  })
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  const text = decoder.decode(value);
  // Parse SSE format
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = JSON.parse(line.substring(6));
      console.log('Event:', data);
    }
  }
}
```

### Browser Client (EventSource)

```javascript
// Using EventSource API for GET endpoint
const url = encodeURIComponent('/path/to/image.jpg');
const eventSource = new EventSource(`http://localhost:8080/stream/${url}`);

eventSource.addEventListener('feature_update', (event) => {
  const data = JSON.parse(event.data);
  console.log('Feature update:', data);
});

eventSource.addEventListener('complete', (event) => {
  console.log('Extraction complete');
  eventSource.close();
});

eventSource.onerror = (error) => {
  console.error('Connection error:', error);
  eventSource.close();
};
```

## Testing SSE with Browser

Open `test/test-sse.html` in a browser to test the SSE streaming functionality:

```bash
# Open in default browser (Linux)
xdg-open test/test-sse.html

# Or serve it with a simple HTTP server
python3 -m http.server 8000
# Then navigate to http://localhost:8000/test/test-sse.html
```

## Environment Variables

```bash
PORT=3000                    # Server port
DATABASE_PATH=./data/features.db  # Database location
LOG_LEVEL=info              # Logging level (debug, info, error)
```

## CORS Support

The server includes CORS headers to allow cross-origin requests:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type`

## Error Handling

All errors return JSON with an error message:

```json
{
  "error": "Error message here"
}
```

HTTP status codes:
- `200` - Success
- `400` - Bad request (invalid parameters)
- `404` - Not found
- `405` - Method not allowed
- `500` - Internal server error

## Performance Considerations

1. **Connection Limits**: The server handles multiple concurrent SSE connections
2. **Streaming**: SSE streams are chunked for efficient memory usage
3. **Database**: Uses SQLite WAL mode for better concurrency
4. **Cleanup**: Automatic cleanup of expired features every hour

## Production Deployment

For production use:

1. **Use a process manager:**
```bash
# With PM2
pm2 start npm --name "mcp-feature-store" -- run http 8080

# With systemd
# Create /etc/systemd/system/mcp-feature-store.service
```

2. **Set up reverse proxy (nginx):**
```nginx
location /mcp-api/ {
  proxy_pass http://localhost:8080/;
  proxy_http_version 1.1;
  proxy_set_header Connection '';
  proxy_buffering off;
  proxy_cache off;
  # For SSE support
  proxy_set_header X-Accel-Buffering no;
}
```

3. **Configure environment:**
```bash
export NODE_ENV=production
export PORT=8080
export DATABASE_PATH=/var/lib/mcp-feature-store/features.db
export LOG_LEVEL=error
```

## Monitoring

The server logs all requests and errors. Monitor the logs:

```bash
# Follow logs in development
npm run http:dev 2>&1 | tee server.log

# With JSON logging
LOG_LEVEL=debug npm run http | jq .
```