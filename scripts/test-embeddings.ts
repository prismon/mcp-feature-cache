#!/usr/bin/env tsx
import { FeatureDatabase } from '../src/db/database.js';
import { DirectFeatureOrchestrator } from '../src/core/direct-orchestrator.js';
import { createLogger } from '../src/utils/logger.js';
import { readFile } from 'fs/promises';
import { join } from 'path';

const logger = createLogger('test-embeddings');

async function testEmbeddings() {
  // Check for OpenAI API key
  if (!process.env.OPENAI_API_KEY) {
    logger.warn('OPENAI_API_KEY not set. Embedding generation will be disabled.');
    logger.info('To enable embeddings, set the OPENAI_API_KEY environment variable:');
    logger.info('export OPENAI_API_KEY="your-api-key"');
  }

  // Initialize database (use same path as the main app)
  const db = new FeatureDatabase();

  // Initialize orchestrator
  const orchestrator = new DirectFeatureOrchestrator(db);

  // Test files
  const testFiles = [
    'README.md',
    'DESIGN.md',
    'src/express-mcp-server.ts'
  ];

  for (const file of testFiles) {
    const filePath = join(process.cwd(), file);
    
    try {
      logger.info(`\n=== Testing ${file} ===`);
      
      // Extract features with embeddings
      const features = await orchestrator.extractFeatures(filePath, {
        force: true,
        includeEmbeddings: true,
        ttl: 86400
      });

      // Count feature types
      const featureCounts: Record<string, number> = {};
      for (const feature of features) {
        const type = feature.featureKey.split('.')[0];
        featureCounts[type] = (featureCounts[type] || 0) + 1;
      }

      logger.info(`Extracted ${features.length} total features:`);
      for (const [type, count] of Object.entries(featureCounts)) {
        logger.info(`  - ${type}: ${count} features`);
      }

      // Show embedding features specifically
      const embeddingFeatures = features.filter(f => f.featureKey.startsWith('embedding.'));
      if (embeddingFeatures.length > 0) {
        logger.info(`\nEmbedding features:`);
        for (const feature of embeddingFeatures) {
          const metadata = feature.metadata || {};
          const valuePreview = feature.value.substring(0, 50) + '...';
          logger.info(`  - ${feature.featureKey}:`);
          logger.info(`    - Model: ${metadata.model || 'unknown'}`);
          logger.info(`    - Dimensions: ${metadata.dimensions || 'unknown'}`);
          if (metadata.chunk_index !== undefined) {
            logger.info(`    - Chunk: ${metadata.chunk_index + 1}/${metadata.total_chunks}`);
          }
          if (metadata.aggregation) {
            logger.info(`    - Aggregation: ${metadata.aggregation}`);
          }
          logger.info(`    - Value preview: ${valuePreview}`);
        }
      } else {
        logger.info('No embedding features generated (check OPENAI_API_KEY)');
      }

    } catch (error) {
      logger.error(`Failed to process ${file}:`, error);
    }
  }

  // Get database stats
  const stats = await db.getStats();
  logger.info('\n=== Database Stats ===');
  logger.info(`Total resources: ${stats.totalResources}`);
  logger.info(`Total features: ${stats.totalFeatures}`);
  logger.info(`Active features: ${stats.activeFeatures}`);
  logger.info(`Expired features: ${stats.expiredFeatures}`);
  
  if (stats.featuresByType) {
    logger.info('\nFeatures by type:');
    for (const [type, count] of Object.entries(stats.featuresByType)) {
      logger.info(`  - ${type}: ${count}`);
    }
  }

  await db.close();
}

// Run test
testEmbeddings().catch(error => {
  logger.error('Test failed:', error);
  process.exit(1);
});