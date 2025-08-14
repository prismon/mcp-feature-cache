#!/usr/bin/env tsx

/**
 * Test the MCP server directly
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function testServer() {
  console.log('🧪 Testing MCP Feature Store Server\n');

  const client = new Client({
    name: 'test-client',
    version: '1.0.0'
  }, {
    capabilities: {}
  });

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/index.ts'],
    env: { ...process.env, LOG_LEVEL: 'error' }
  });

  try {
    await client.connect(transport);
    console.log('✅ Connected to MCP server\n');

    // List tools
    console.log('📋 Available tools:');
    const toolsResponse = await client.request({
      method: 'tools/list',
      params: {}
    }) as any;

    for (const tool of toolsResponse.tools) {
      console.log(`  - ${tool.name}`);
    }

    // Get stats
    console.log('\n📊 Database statistics:');
    const statsResult = await client.request({
      method: 'tools/call',
      params: {
        name: 'stats',
        arguments: {}
      }
    }) as any;
    
    const stats = JSON.parse(statsResult.content[0].text);
    console.log(`  Resources: ${stats.totalResources}`);
    console.log(`  Features: ${stats.totalFeatures}`);
    console.log(`  Expired: ${stats.expiredFeatures}`);

    // Query features
    console.log('\n🔍 Querying stored features:');
    const queryResult = await client.request({
      method: 'tools/call',
      params: {
        name: 'query',
        arguments: {
          featureKeys: ['image.dimensions', 'image.format']
        }
      }
    }) as any;

    const features = JSON.parse(queryResult.content[0].text);
    console.log(`  Found ${features.length} features`);
    
    for (const feature of features) {
      const value = feature.valueType === 'json' ? 
        JSON.stringify(JSON.parse(feature.value)) : 
        feature.value;
      console.log(`  - ${feature.featureKey}: ${value}`);
    }

    // List extractors
    console.log('\n🔧 Registered extractors:');
    const extractorsResult = await client.request({
      method: 'tools/call',
      params: {
        name: 'list_extractors',
        arguments: {}
      }
    }) as any;

    const extractors = JSON.parse(extractorsResult.content[0].text);
    for (const extractor of extractors) {
      console.log(`  - ${extractor.toolName} (${extractor.enabled ? 'enabled' : 'disabled'})`);
    }

    console.log('\n✅ All tests passed!');
    await client.close();

  } catch (error: any) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

testServer();