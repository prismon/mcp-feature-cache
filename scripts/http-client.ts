#!/usr/bin/env tsx

/**
 * HTTP Client for MCP Feature Store
 * Test the HTTP API with streaming support
 */

const API_URL = process.env.API_URL || 'http://localhost:8080';

async function extract(url: string, stream = false) {
  console.log(`\n📤 Extracting features from: ${url}`);
  console.log(`   Streaming: ${stream ? 'Yes' : 'No'}\n`);

  const response = await fetch(`${API_URL}/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, stream, ttl: 3600 })
  });

  if (stream) {
    // Handle SSE stream
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data:')) {
          try {
            const data = JSON.parse(line.substring(5).trim());
            console.log(`📡 ${data.type}:`, JSON.stringify(data, null, 2));
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    }
  } else {
    // Handle regular JSON response
    const data = await response.json();
    console.log('✅ Response:', JSON.stringify(data, null, 2));
  }
}

async function query(featureKeys?: string[]) {
  console.log('\n🔍 Querying features...');
  
  const response = await fetch(`${API_URL}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ featureKeys })
  });

  const data = await response.json();
  console.log('✅ Found features:', JSON.stringify(data, null, 2));
}

async function stats() {
  console.log('\n📊 Getting statistics...');
  
  const response = await fetch(`${API_URL}/stats`);
  const data = await response.json();
  
  console.log('Database Statistics:');
  console.log(`  Resources: ${data.totalResources}`);
  console.log(`  Features: ${data.totalFeatures}`);
  console.log(`  Expired: ${data.expiredFeatures}`);
  console.log(`  Active Extractors: ${data.activeExtractors}`);
}

async function listExtractors() {
  console.log('\n🔧 Listing extractors...');
  
  const response = await fetch(`${API_URL}/extractors`);
  const data = await response.json();
  
  console.log('Registered Extractors:');
  for (const extractor of data.extractors) {
    console.log(`  - ${extractor.toolName} (${extractor.enabled ? 'enabled' : 'disabled'})`);
    console.log(`    Server: ${extractor.serverUrl}`);
    console.log(`    Features: ${extractor.featureKeys.join(', ')}`);
  }
}

async function main() {
  const command = process.argv[2];
  const arg = process.argv[3];

  if (!command || command === '--help') {
    console.log(`
MCP Feature Store HTTP Client

Usage:
  npx tsx scripts/http-client.ts <command> [args]

Commands:
  extract <url>           Extract features from a resource
  extract-stream <url>    Extract with SSE streaming
  query [keys]           Query stored features
  stats                  Get database statistics
  extractors             List registered extractors

Examples:
  npx tsx scripts/http-client.ts extract /path/to/image.jpg
  npx tsx scripts/http-client.ts extract-stream https://example.com/image.png
  npx tsx scripts/http-client.ts query "image.dimensions,image.format"
  npx tsx scripts/http-client.ts stats

Environment:
  API_URL=${API_URL}
`);
    process.exit(0);
  }

  try {
    switch (command) {
      case 'extract':
        if (!arg) throw new Error('URL required');
        await extract(arg, false);
        break;
        
      case 'extract-stream':
        if (!arg) throw new Error('URL required');
        await extract(arg, true);
        break;
        
      case 'query':
        const keys = arg ? arg.split(',') : undefined;
        await query(keys);
        break;
        
      case 'stats':
        await stats();
        break;
        
      case 'extractors':
        await listExtractors();
        break;
        
      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();