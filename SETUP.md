# MCP Feature Store - Setup Guide

## Installation

### 1. Prerequisites

```bash
# Install Node.js (v18+ required)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install ffmpeg (for video processing)
sudo apt-get update
sudo apt-get install -y ffmpeg

# Clone and setup the project
cd /path/to/your/projects
git clone <your-repo-url> mcp-feature-store
cd mcp-feature-store
npm install
```

### 2. Initialize Database

```bash
# Create the SQLite database with schema
npm run db:init
```

## Running Tests

### Test Image Processing
```bash
# Test with generated image
npx tsx test/test-extractor.ts

# Test with your own image
npx tsx test/test-extractor.ts /path/to/your/image.jpg
```

### Verify ffmpeg Installation
```bash
ffmpeg -version
```

## Manual Database Population

### Process Single Files
```bash
# Process an image
npx tsx scripts/populate-db.ts /path/to/image.jpg

# Process from URL
npx tsx scripts/populate-db.ts https://example.com/image.png

# Process a text file
npx tsx scripts/populate-db.ts /path/to/document.txt
```

### Process Entire Directories
```bash
# Process all supported files in a directory
npx tsx scripts/populate-db.ts /path/to/images/

# Check database statistics
npx tsx scripts/populate-db.ts --stats
```

### Supported Formats
- **Images**: jpg, jpeg, png, gif, webp, bmp
- **Text**: txt, md, json, html, css, js, ts
- **Videos**: mp4, avi, mov, mkv (requires ffmpeg)

## Claude Desktop Integration

### Method 1: Direct Configuration

1. Open Claude Desktop settings
2. Navigate to Developer > Model Context Protocol
3. Add the following configuration:

```json
{
  "mcpServers": {
    "mcp-feature-store": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mcp-feature-store/src/index.ts"],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/mcp-feature-store/data/features.db",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

### Method 2: Using Config File

1. Locate Claude Desktop config directory:
   - **macOS**: `~/Library/Application Support/Claude/`
   - **Linux**: `~/.config/Claude/`
   - **Windows**: `%APPDATA%\Claude\`

2. Edit or create `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcp-feature-store": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-feature-store/dist/index.js"],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/mcp-feature-store/data/features.db",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

3. Build the project first if using compiled version:
```bash
npm run build
```

4. Restart Claude Desktop

### Method 3: Development Mode

For development with auto-reload:

```json
{
  "mcpServers": {
    "mcp-feature-store": {
      "command": "npx",
      "args": ["tsx", "watch", "/path/to/mcp-feature-store/src/index.ts"],
      "env": {
        "DATABASE_PATH": "/path/to/mcp-feature-store/data/features.db",
        "LOG_LEVEL": "debug"
      }
    }
  }
}
```

## Using with Claude Desktop

Once configured, you can use these commands in Claude Desktop:

### Extract Features
```
Use the mcp-feature-store tool to extract features from /path/to/image.jpg
```

### Query Features
```
Query all image thumbnails from the feature store
```

### List Available Extractors
```
List all registered feature extractors in mcp-feature-store
```

### Get Statistics
```
Show mcp-feature-store database statistics
```

## Available MCP Tools

The following tools are available through Claude Desktop:

1. **extract**: Extract features from a file or URL
   - Parameters: url, extractors[], ttl, stream, force

2. **query**: Query stored features
   - Parameters: url, featureKeys[], extractors[], includeExpired

3. **register_extractor**: Register new MCP extractors
   - Parameters: toolName, serverUrl, capabilities[], featureKeys[]

4. **list_extractors**: List all registered extractors
   - Parameters: enabled, capability

5. **update_ttl**: Update feature TTL
   - Parameters: url, featureKey, ttl

6. **stats**: Get database statistics
   - No parameters required

## Running Standalone Services

### Start Main Orchestrator
```bash
npm run dev:orchestrator
```

### Start Individual Extractors (optional)
```bash
# In separate terminals
npm run dev:image
npm run dev:text     # (when implemented)
npm run dev:embedding # (when implemented)
```

## Troubleshooting

### Database Issues
```bash
# Reset database
rm data/features.db
npm run db:init
```

### Check Logs
```bash
# Set debug logging
export LOG_LEVEL=debug
npm run dev:orchestrator
```

### Test Connection
```bash
# Test if MCP server starts correctly
npx tsx src/index.ts
# Should see: "MCP Feature Store server started"
```

### Common Issues

1. **ffmpeg not found**: Install ffmpeg for video support
2. **Permission denied**: Check file permissions on database and image files
3. **Port already in use**: Kill existing processes or change port
4. **Claude Desktop not finding tools**: Restart Claude Desktop after config changes

## Environment Variables

```bash
# Create .env file
DATABASE_PATH=./data/features.db
LOG_LEVEL=info
MAX_FILE_SIZE=104857600  # 100MB in bytes
OPENAI_API_KEY=sk-...    # For embedding generation
```

## Example Workflow

1. **Populate database with images**:
```bash
npx tsx scripts/populate-db.ts ~/Pictures/
```

2. **Check what was stored**:
```bash
npx tsx scripts/populate-db.ts --stats
```

3. **Use in Claude Desktop**:
```
Can you query the feature store for all images with thumbnails?
```

4. **Extract features from new URL**:
```
Extract features from https://example.com/image.jpg with 1 hour TTL
```