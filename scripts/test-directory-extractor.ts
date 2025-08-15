#!/usr/bin/env tsx
import { createLogger } from '../src/utils/logger.js';

const logger = createLogger('test-directory-extractor');

async function testDirectoryExtractor() {
  const serverUrl = 'http://localhost:3000';
  
  logger.info('Testing directory extractor');
  
  // Test extracting features for a directory
  logger.info('\n=== Test 1: Extract features for a directory ===');
  
  const directoryPath = '/home/josh/Projects/mcp-feature-store/src/utils';
  
  try {
    const response = await fetch(`${serverUrl}/mcp`, {
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
            url: directoryPath,
            ttl: 3600
          }
        },
        id: 1
      })
    });
    
    // Parse SSE response
    const text = await response.text();
    const lines = text.split('\n');
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const result = JSON.parse(data);
          
          if (result.error) {
            logger.error('Error extracting directory features:', result.error);
          } else {
            logger.info('Directory features extracted successfully');
            
            // Parse the response to get feature count
            try {
              const features = JSON.parse(result.result.content[0].text);
              logger.info(`Extracted ${features.length} features for ${directoryPath}`);
              
              // Display directory features
              for (const feature of features) {
                if (feature.featureKey.startsWith('directory.')) {
                  logger.info(`  ${feature.featureKey}: ${
                    feature.featureKey === 'directory.metadata' 
                      ? '(metadata object)' 
                      : feature.value
                  }`);
                  
                  if (feature.metadata?.formatted) {
                    logger.info(`    Formatted: ${feature.metadata.formatted}`);
                  }
                }
              }
            } catch (e) {
              logger.debug('Could not parse features');
            }
          }
          break;
        } catch (e) {
          // Continue to next line
        }
      }
    }
  } catch (error) {
    logger.error('Failed to extract directory features:', error);
  }
  
  // Test 2: Query directory features via API
  logger.info('\n=== Test 2: Query directory features via API ===');
  
  const encodedUrl = encodeURIComponent(`file://${directoryPath}`);
  
  try {
    const listResponse = await fetch(`${serverUrl}/api/features/${encodedUrl}`);
    const features = await listResponse.json();
    
    logger.info(`Found ${features.featureCount} features for the directory`);
    
    if (features.features && features.features.length > 0) {
      logger.info('Directory features:');
      for (const f of features.features) {
        if (f.featureKey.startsWith('directory.')) {
          logger.info(`  - ${f.featureKey} (${f.valueType})`);
        }
      }
      
      // Fetch directory metadata
      const metadataResponse = await fetch(
        `${serverUrl}/api/features/${encodedUrl}/directory.metadata`
      );
      
      if (metadataResponse.ok) {
        const metadataFeature = await metadataResponse.json();
        const metadata = JSON.parse(metadataFeature.value);
        
        logger.info('\nDirectory metadata:');
        logger.info(`  Name: ${metadata.name}`);
        logger.info(`  Path: ${metadata.path}`);
        logger.info(`  File count: ${metadata.fileCount}`);
        logger.info(`  Subdirectory count: ${metadata.subdirectoryCount}`);
        logger.info(`  Total size: ${metadata.totalSize} bytes`);
        logger.info(`  Average file size: ${metadata.averageFileSize} bytes`);
        
        if (metadata.largestFiles && metadata.largestFiles.length > 0) {
          logger.info('  Largest files:');
          metadata.largestFiles.slice(0, 3).forEach((f: any) => {
            logger.info(`    - ${f.name}: ${f.sizeFormatted}`);
          });
        }
        
        if (metadata.fileExtensions) {
          logger.info('  File extensions:');
          Object.entries(metadata.fileExtensions).forEach(([ext, count]) => {
            logger.info(`    ${ext}: ${count} file(s)`);
          });
        }
      }
    }
  } catch (error) {
    logger.error('Failed to query directory features:', error);
  }
  
  // Test 3: List extractors to verify directory extractor is included
  logger.info('\n=== Test 3: List extractors ===');
  
  try {
    const response = await fetch(`${serverUrl}/mcp`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'list_extractors',
          arguments: {}
        },
        id: 2
      })
    });
    
    // Parse SSE response
    const text = await response.text();
    const lines = text.split('\n');
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const result = JSON.parse(data);
          
          if (result.result) {
            const extractors = JSON.parse(result.result.content[0].text);
            const directoryExtractor = extractors.find((e: any) => 
              e.toolName === 'directory-extractor'
            );
            
            if (directoryExtractor) {
              logger.info('Directory extractor found:');
              logger.info(`  Name: ${directoryExtractor.toolName}`);
              logger.info(`  Description: ${directoryExtractor.description}`);
              logger.info(`  Capabilities: ${directoryExtractor.capabilities.join(', ')}`);
              logger.info(`  Enabled: ${directoryExtractor.enabled}`);
            } else {
              logger.warn('Directory extractor not found in list');
            }
          }
          break;
        } catch (e) {
          // Continue to next line
        }
      }
    }
  } catch (error) {
    logger.error('Failed to list extractors:', error);
  }
  
  logger.info('\n=== Testing complete ===');
}

// Run the test
testDirectoryExtractor().catch(error => {
  logger.error('Test failed:', error);
  process.exit(1);
});