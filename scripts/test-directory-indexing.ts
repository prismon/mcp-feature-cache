#!/usr/bin/env tsx
import { createLogger } from '../src/utils/logger.js';

const logger = createLogger('test-directory-indexing');

// Helper function to parse SSE response
async function parseSSEResponse(response: Response): Promise<any> {
  const text = await response.text();
  const lines = text.split('\n');
  
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      try {
        return JSON.parse(data);
      } catch (e) {
        // Continue to next line
      }
    }
  }
  
  throw new Error('No valid JSON data found in SSE response');
}

async function testDirectoryIndexing() {
  const serverUrl = 'http://localhost:3000';
  
  logger.info('Testing directory indexing feature');
  
  // Test 1: Request features for a file (should trigger directory indexing)
  logger.info('\n=== Test 1: Extract features for a file (triggers directory indexing) ===');
  
  const testFile = '/home/josh/Projects/mcp-feature-store/src/utils/logger.ts';
  
  try {
    const extractResponse = await fetch(`${serverUrl}/mcp`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'extract',
          arguments: {
            url: testFile,
            ttl: 3600
          }
        },
        id: 1
      })
    });
    
    const result = await parseSSEResponse(extractResponse);
    
    if (result.error) {
      logger.error('Error extracting features:', result.error);
    } else {
      logger.info('Features extracted successfully');
      
      // Parse the response to get feature count
      try {
        const features = JSON.parse(result.result.content[0].text);
        logger.info(`Extracted ${features.length} features for ${testFile}`);
        
        // Show thumbnail URLs if present
        const thumbnailFeatures = features.filter((f: any) => 
          f.featureKey?.includes('thumbnail')
        );
        
        if (thumbnailFeatures.length > 0) {
          logger.info('Thumbnail URLs:');
          thumbnailFeatures.forEach((f: any) => {
            logger.info(`  ${f.featureKey}: ${f.value}`);
          });
        }
      } catch (e) {
        logger.debug('Could not parse features');
      }
    }
  } catch (error) {
    logger.error('Failed to extract features:', error);
  }
  
  // Wait a bit for directory indexing to complete
  logger.info('\nWaiting for directory indexing to complete...');
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Test 2: Query features for the directory
  logger.info('\n=== Test 2: Query indexed directory features ===');
  
  const directoryUrl = 'file:///home/josh/Projects/mcp-feature-store/src/utils';
  
  try {
    const queryResponse = await fetch(`${serverUrl}/mcp`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'query',
          arguments: {
            url: directoryUrl,
            featureKeys: ['directory.index_metadata']
          }
        },
        id: 2
      })
    });
    
    const result = await parseSSEResponse(queryResponse);
    
    if (result.error) {
      logger.error('Error querying directory features:', result.error);
    } else {
      try {
        const features = JSON.parse(result.result.content[0].text);
        if (features.length > 0) {
          const metadata = JSON.parse(features[0].value);
          logger.info('Directory index metadata:');
          logger.info(`  Indexed at: ${new Date(metadata.indexedAt * 1000).toISOString()}`);
          logger.info(`  Total files: ${metadata.fileCount}`);
          logger.info(`  Indexed: ${metadata.indexedCount}`);
          logger.info(`  Skipped: ${metadata.skippedCount}`);
          logger.info(`  Errors: ${metadata.errorCount}`);
          
          if (metadata.files && metadata.files.length > 0) {
            logger.info(`  Sample indexed files:`);
            metadata.files.slice(0, 5).forEach((file: string) => {
              logger.info(`    - ${file}`);
            });
          }
        } else {
          logger.info('No directory metadata found');
        }
      } catch (e) {
        logger.debug('Could not parse directory metadata');
      }
    }
  } catch (error) {
    logger.error('Failed to query directory features:', error);
  }
  
  // Test 3: Test the feature value API
  logger.info('\n=== Test 3: Test feature value API ===');
  
  const encodedUrl = encodeURIComponent(`file://${testFile}`);
  
  try {
    // List all features for the file
    const listResponse = await fetch(`${serverUrl}/api/features/${encodedUrl}`);
    const features = await listResponse.json();
    
    logger.info(`Found ${features.featureCount} features for the file`);
    
    if (features.features && features.features.length > 0) {
      logger.info('Available features:');
      features.features.slice(0, 5).forEach((f: any) => {
        logger.info(`  - ${f.featureKey} (${f.valueType})`);
        if (f.valueUrl) {
          logger.info(`    URL: ${f.valueUrl}`);
        }
      });
      
      // Try to fetch a specific feature
      const textFeature = features.features.find((f: any) => 
        f.featureKey === 'text.content'
      );
      
      if (textFeature) {
        const valueResponse = await fetch(
          `${serverUrl}/api/features/${encodedUrl}/text.content`
        );
        const featureValue = await valueResponse.json();
        
        logger.info('\nFetched text.content feature:');
        logger.info(`  Value preview: ${featureValue.value.substring(0, 100)}...`);
        logger.info(`  Generated at: ${new Date(featureValue.generatedAt * 1000).toISOString()}`);
      }
    }
  } catch (error) {
    logger.error('Failed to test feature API:', error);
  }
  
  // Test 4: Batch API
  logger.info('\n=== Test 4: Test batch feature API ===');
  
  try {
    const batchResponse = await fetch(`${serverUrl}/api/features/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [
          {
            resourceUrl: `file://${testFile}`,
            featureKey: 'text.word_count'
          },
          {
            resourceUrl: `file://${testFile}`,
            featureKey: 'text.line_count'
          },
          {
            resourceUrl: directoryUrl,
            featureKey: 'directory.index_metadata'
          }
        ]
      })
    });
    
    const batchResult = await batchResponse.json();
    
    if (batchResult.results) {
      logger.info(`Batch API returned ${batchResult.results.length} results:`);
      batchResult.results.forEach((r: any, i: number) => {
        if (r.error) {
          logger.info(`  ${i + 1}. ${r.featureKey || 'unknown'}: ERROR - ${r.error}`);
        } else {
          logger.info(`  ${i + 1}. ${r.featureKey}: ${r.value}`);
        }
      });
    }
  } catch (error) {
    logger.error('Failed to test batch API:', error);
  }
  
  logger.info('\n=== Testing complete ===');
}

// Run the test
testDirectoryIndexing().catch(error => {
  logger.error('Test failed:', error);
  process.exit(1);
});