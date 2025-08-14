# MCP Feature Store - Complete Setup Instructions

## ✅ Test Results

- **ffmpeg**: ✅ Installed (version 7.1.1)
- **Image Processing**: ✅ Working (sharp library functional)
- **Database**: ✅ Initialized with 1 resource and 6 features
- **Thumbnails**: ✅ Generated successfully in PNG format

## 📦 Installation & Setup

### Quick Start
```bash
# 1. Install dependencies
npm install

# 2. Initialize database
npm run db:init

# 3. Test image processing
npx tsx test/test-extractor.ts

# 4. Populate database with test image
npx tsx scripts/populate-db.ts test/test-image.png
```

## 🔧 Manual Database Population

### Single File Processing
```bash
# Process any image
npx tsx scripts/populate-db.ts /path/to/image.jpg

# Process from URL
npx tsx scripts/populate-db.ts https://example.com/image.png

# Process entire directory
npx tsx scripts/populate-db.ts ~/Pictures/
```

### Check Database Contents
```bash
# View statistics
npx tsx scripts/populate-db.ts --stats

# Query database directly
sqlite3 data/features.db "SELECT feature_key, value_type FROM features;"
```

## 🖥️ Claude Desktop Integration

### Step 1: Locate Claude Desktop Config

Find your Claude Desktop configuration file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`  
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

### Step 2: Add MCP Server Configuration

Edit the config file and add:

```json
{
  "mcpServers": {
    "mcp-feature-store": {
      "command": "node",
      "args": [
        "--import",
        "tsx",
        "/absolute/path/to/mcp-feature-store/src/index.ts"
      ],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/mcp-feature-store/data/features.db",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

**Important**: Replace `/absolute/path/to/` with your actual project path!

### Alternative: Using npx

```json
{
  "mcpServers": {
    "mcp-feature-store": {
      "command": "npx",
      "args": [
        "tsx",
        "/absolute/path/to/mcp-feature-store/src/index.ts"
      ],
      "env": {
        "DATABASE_PATH": "/absolute/path/to/mcp-feature-store/data/features.db"
      }
    }
  }
}
```

### Step 3: Restart Claude Desktop

After saving the config, completely quit and restart Claude Desktop.

### Step 4: Verify Integration

In Claude Desktop, you can now use:

```
List the available tools from mcp-feature-store
```

Expected tools:
- `extract` - Extract features from files/URLs
- `query` - Query stored features
- `stats` - Get database statistics
- `list_extractors` - List registered extractors
- `register_extractor` - Register new extractors
- `update_ttl` - Update feature TTL

## 📸 Features Extracted

For each image, the system extracts:

1. **Thumbnails** (PNG format):
   - Small: 150x150px
   - Medium: 400x400px
   - Large: 1920x1080px

2. **Metadata**:
   - Dimensions (width x height)
   - Format (png, jpg, etc.)
   - Dominant colors
   - File size

3. **For Videos** (requires ffmpeg):
   - Timeline snapshots at 10% intervals
   - Main thumbnail from middle frame
   - Duration, FPS, dimensions

## 🎯 Usage Examples in Claude Desktop

### Extract Features from Image
```
Use mcp-feature-store to extract features from /home/user/photo.jpg
```

### Query Stored Features
```
Query all image thumbnails from mcp-feature-store
```

### Get Statistics
```
Show mcp-feature-store database statistics
```

### Extract from URL
```
Extract features from https://example.com/image.png using mcp-feature-store
```

## 🧪 Testing

### Test Image Processing
```bash
# With generated test image
npx tsx test/test-extractor.ts

# With your own image
npx tsx test/test-extractor.ts /path/to/your/image.jpg
```

### Check Generated Thumbnails
```bash
ls -la test/output/
# Should see: thumbnail-small.png, thumbnail-medium.png, thumbnail-large.png
```

## 📊 Current Database Status

```
Resources: 1
Features: 6
- image.thumbnail.small (binary)
- image.thumbnail.medium (binary)
- image.thumbnail.large (binary)
- image.dimensions (json)
- image.format (text)
- image.dominant_colors (json)
```

## 🚀 Running Services

### For Development
```bash
# Main orchestrator (with auto-reload)
npm run dev:orchestrator

# Image extractor service
npm run dev:image
```

### For Production
```bash
# Build first
npm run build

# Then run
npm start
```

## ⚠️ Troubleshooting

### If Claude Desktop doesn't see the tools:
1. Check the config file path is correct
2. Use absolute paths in the configuration
3. Restart Claude Desktop completely
4. Check logs: `LOG_LEVEL=debug npm run dev:orchestrator`

### If image processing fails:
1. Check sharp is installed: `npm ls sharp`
2. Reinstall if needed: `npm install sharp`
3. For videos, ensure ffmpeg is installed: `which ffmpeg`

### Database issues:
```bash
# Reset database
rm data/features.db
npm run db:init
```

## 📝 Notes

- All thumbnails are generated in PNG format for consistency
- Features have a 24-hour TTL by default
- The system supports both local files and URLs
- Video processing requires ffmpeg to be installed separately