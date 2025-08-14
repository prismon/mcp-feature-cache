# MCP Feature Store - Final Working Setup

## ✅ Current Status

The MCP Feature Store is now fully operational with:
- **Express server** running on port 8080
- **Built-in extractors** for images, videos, and text
- **SQLite database** with 4 resources and 12+ features
- **MCP protocol** compatible with MCP Inspector

## 🚀 Quick Start

### 1. Start the Server

```bash
# Start on port 8080
npm run express-mcp 8080

# Or with auto-reload for development
npm run express-mcp:dev 8080
```

### 2. Test Feature Extraction

```bash
# Extract features from an image
curl -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc":"2.0",
    "method":"tools/call",
    "params":{
      "name":"extract",
      "arguments":{
        "url":"/path/to/image.jpg"
      }
    },
    "id":1
  }'
```

### 3. Use with MCP Inspector

1. Open MCP Inspector
2. Connect to: `http://localhost:8080`
3. Select **"Streamable HTTP"** as transport type
4. The tools will appear and can be tested

## 📊 Available MCP Tools

### extract
Extract features from images, videos, or text files
```json
{
  "name": "extract",
  "arguments": {
    "url": "/path/to/file",
    "force": true,  // optional: force re-extraction
    "ttl": 3600     // optional: TTL in seconds
  }
}
```

### query
Query stored features from the database
```json
{
  "name": "query",
  "arguments": {
    "url": "/path/to/file",        // optional
    "featureKeys": ["image.dimensions"],  // optional
    "includeExpired": false         // optional
  }
}
```

### stats
Get database statistics
```json
{
  "name": "stats",
  "arguments": {}
}
```

### list_extractors
List registered extractors
```json
{
  "name": "list_extractors",
  "arguments": {
    "enabled": true,     // optional
    "capability": "image/jpeg"  // optional
  }
}
```

## 🎯 Features Extracted

### For Images (jpg, png, gif, webp)
- `image.thumbnail.small` - 150x150 PNG thumbnail (base64)
- `image.thumbnail.medium` - 400x400 PNG thumbnail (base64)
- `image.thumbnail.large` - 1920x1080 PNG thumbnail (base64)
- `image.dimensions` - Width and height JSON
- `image.format` - Image format
- `image.dominant_colors` - Color statistics

### For Videos (mp4, avi, mov) - Requires ffmpeg
- `video.thumbnail` - Middle frame thumbnail
- `video.dimensions` - Width and height
- `video.duration` - Length in seconds

### For Text Files (txt, md, json, html)
- `text.content` - First 10,000 characters
- `text.word_count` - Number of words
- `text.line_count` - Number of lines
- `text.char_count` - Total characters

## 🔧 Manual Database Operations

### Populate from Command Line
```bash
# Process single file
npx tsx scripts/populate-db.ts /path/to/image.jpg

# Process directory
npx tsx scripts/populate-db.ts /path/to/images/

# Check stats
npx tsx scripts/populate-db.ts --stats
```

### Direct API Testing
```bash
# Health check
curl http://localhost:8080/health

# API documentation
curl http://localhost:8080/
```

## 📝 Important Notes

1. **Stateless Design**: Each request creates a new server instance for isolation
2. **Built-in Extractors**: Uses DirectFeatureOrchestrator with built-in extractors
3. **No External Dependencies**: Doesn't require external MCP extractors running
4. **ffmpeg Optional**: Video extraction requires ffmpeg installed

## 🐛 Troubleshooting

### If extraction fails:
1. Check file path is absolute or relative to project root
2. Ensure file exists and is readable
3. Check supported formats (image/*, video/*, text/*)

### If server doesn't respond:
1. Check port 8080 is not in use
2. Kill any old processes: `killall -9 node tsx`
3. Restart server: `npm run express-mcp 8080`

### Check logs:
```bash
# Run with debug logging
LOG_LEVEL=debug npm run express-mcp 8080
```

## ✅ Working Example

```bash
# Start server
npm run express-mcp 8080

# Extract features from test image
curl -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc":"2.0",
    "method":"tools/call",
    "params":{
      "name":"extract",
      "arguments":{
        "url":"test/test-image.png",
        "force":true
      }
    },
    "id":1
  }'

# Response will be in SSE format with extracted features
```

The system is now fully operational and ready for use with MCP Inspector or any MCP-compatible client!