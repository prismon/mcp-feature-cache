# Embedding Generation for RAG

The MCP Feature Store now supports automatic embedding generation for text content, enabling RAG (Retrieval-Augmented Generation) applications.

## Features

- **Automatic text chunking** with configurable chunk size and overlap
- **OpenAI embeddings** using text-embedding-3-small model (configurable)
- **Per-chunk embeddings** for detailed retrieval
- **Document-level embeddings** (averaged) for quick similarity search
- **TTL support** for automatic expiration and refresh

## Configuration

### Setting up OpenAI API Key

```bash
export OPENAI_API_KEY="your-api-key-here"
```

Or add to your `.env` file:
```
OPENAI_API_KEY=your-api-key-here
```

### Embedding Models

By default, the system uses `text-embedding-3-small`. You can configure:
- Model name
- Embedding dimensions
- Chunk size (default: 2000 chars)
- Chunk overlap (default: 200 chars)

## Usage

### Via MCP Tools

When extracting features, add the `includeEmbeddings` flag:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "extract",
    "arguments": {
      "url": "/path/to/document.txt",
      "includeEmbeddings": true,
      "ttl": 86400
    }
  },
  "id": 1
}
```

### Via Scripts

```typescript
const features = await orchestrator.extractFeatures(filePath, {
  includeEmbeddings: true,
  ttl: 86400
});
```

### Testing Embeddings

Run the test script to verify embedding generation:

```bash
npx tsx scripts/test-embeddings.ts
```

## Generated Features

For each text document, the system generates:

1. **Chunk Embeddings** (`embedding.chunk_0`, `embedding.chunk_1`, etc.)
   - One embedding per text chunk
   - Includes metadata: model, dimensions, chunk_index, total_chunks

2. **Document Embedding** (`embedding.document`)
   - Averaged embedding across all chunks
   - Useful for document-level similarity search
   - Includes aggregation metadata

## Querying Embeddings

Retrieve embeddings using the query tool:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "query",
    "arguments": {
      "url": "/path/to/document.txt",
      "featureKeys": ["embedding.document", "embedding.chunk_0"]
    }
  },
  "id": 1
}
```

## Integration with RAG Systems

The embeddings can be used with:
- Vector databases (Pinecone, Weaviate, Qdrant)
- Similarity search engines
- LangChain/LlamaIndex applications
- Custom RAG pipelines

### Example: Vector Search

```typescript
// Get document embedding
const features = await db.queryFeatures({
  url: documentUrl,
  featureKeys: ['embedding.document']
});

const embedding = JSON.parse(features[0].value);

// Use with your vector database
const similar = await vectorDB.search(embedding, {
  topK: 5,
  threshold: 0.8
});
```

## Performance Considerations

- **Chunking**: Larger chunks provide more context but fewer granular matches
- **Overlap**: More overlap improves continuity but increases storage
- **Caching**: Embeddings are cached with TTL to avoid redundant API calls
- **Batch Processing**: Process multiple documents in parallel for efficiency

## Cost Optimization

OpenAI embedding costs depend on token usage:
- text-embedding-3-small: ~$0.02 per 1M tokens
- text-embedding-3-large: ~$0.13 per 1M tokens

Tips:
- Use appropriate chunk sizes
- Set reasonable TTLs
- Cache embeddings in the database
- Monitor token usage

## Troubleshooting

### No embeddings generated
- Check OPENAI_API_KEY is set
- Verify API key has embedding permissions
- Check logs for API errors

### Rate limiting
- Implement retry logic
- Use batch processing
- Consider rate limit headers

### Large documents
- Adjust chunk size for your use case
- Consider document summarization first
- Use streaming for progress updates