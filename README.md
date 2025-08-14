# MCP Feature Store

A streamable Model Context Protocol (MCP) service for extracting, storing, and managing features from various content sources.

## Overview

MCP Feature Store orchestrates feature extraction through MCP tools, providing a flexible pipeline where feature generators are themselves MCP services. This allows for:

- Modular feature extraction through independent MCP tools
- Dynamic registration of new extractors
- Parallel processing with multiple extractors
- TTL-based feature management
- Streaming support for real-time updates

## Quick Start

1. Install dependencies:
```bash
npm install
```

2. Initialize the database:
```bash
npm run db:init
```

3. Start the orchestrator:
```bash
npm run dev:orchestrator
```

4. Start extractors (in separate terminals):
```bash
npm run dev:text
npm run dev:image
npm run dev:embedding
```

## Architecture

The system consists of:
- **Feature Store Orchestrator**: Main MCP server that manages the pipeline
- **MCP Extractor Tools**: Independent services for feature extraction
- **SQLite Database**: Persistent storage with TTL support
- **Streaming Pipeline**: Real-time feature updates

See [DESIGN.md](./DESIGN.md) for detailed architecture documentation.

## Usage

### Extract Features
```typescript
const client = new MCPClient();
await client.connect('mcp-feature-store');

const features = await client.callTool('extract', {
  url: 'https://example.com/document.pdf',
  extractors: ['text', 'embedding'],
  ttl: 3600
});
```

### Query Features
```typescript
const stored = await client.callTool('query', {
  url: 'https://example.com/document.pdf',
  featureKeys: ['text.summary', 'embedding.vector']
});
```

## Available Extractors

- **Text Extractor**: Plain text, summaries, keywords, entities
- **Image Extractor**: Thumbnails, metadata, dominant colors
- **Embedding Generator**: Vector embeddings for RAG
- **Document Analyzer**: Structure, tables, references

## Configuration

Create a `.env` file:
```bash
DATABASE_PATH=./data/features.db
OPENAI_API_KEY=sk-...
MCP_PORT=3000
LOG_LEVEL=info
```

## Development

```bash
# Run tests
npm test

# Type checking
npm run typecheck

# Linting
npm run lint

# Build for production
npm run build
```

## License

MIT