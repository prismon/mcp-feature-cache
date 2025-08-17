#!/usr/bin/env tsx

import { DirectFeatureOrchestrator } from '../src/core/direct-orchestrator.js';
import { FeatureDatabase } from '../src/db/database.js';
import { createLogger } from '../src/utils/logger.js';
import Database from 'better-sqlite3';

const logger = createLogger('test-extraction-modes');

async function testExtractionModes() {
  // Create a temporary test database
  const testDbPath = '/tmp/test-extraction-modes.db';
  
  // Initialize database with schema
  const rawDb = new Database(testDbPath);
  
  const schema = `
    -- Resources table
    CREATE TABLE IF NOT EXISTS resources (
      url TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('file', 'url', 'directory')),
      last_processed INTEGER NOT NULL,
      checksum TEXT,
      size INTEGER,
      mime_type TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    -- Features table with TTL support
    CREATE TABLE IF NOT EXISTS features (
      id TEXT PRIMARY KEY,
      resource_url TEXT NOT NULL,
      feature_key TEXT NOT NULL,
      value TEXT NOT NULL,
      value_type TEXT NOT NULL CHECK(value_type IN ('text', 'number', 'binary', 'embedding', 'json')),
      generated_at INTEGER NOT NULL,
      ttl INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      extractor_tool TEXT NOT NULL,
      metadata TEXT,
      FOREIGN KEY (resource_url) REFERENCES resources(url) ON DELETE CASCADE,
      UNIQUE(resource_url, feature_key)
    );

    -- Extractor registry
    CREATE TABLE IF NOT EXISTS extractors (
      tool_name TEXT PRIMARY KEY,
      server_url TEXT NOT NULL,
      capabilities TEXT NOT NULL,
      feature_keys TEXT NOT NULL,
      priority INTEGER DEFAULT 100,
      enabled BOOLEAN DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_features_resource_url ON features(resource_url);
    CREATE INDEX IF NOT EXISTS idx_features_expires_at ON features(expires_at);
    CREATE INDEX IF NOT EXISTS idx_features_feature_key ON features(feature_key);
    CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
  `;
  
  rawDb.exec(schema);
  rawDb.close();
  
  const db = new FeatureDatabase(testDbPath);
  
  const orchestrator = new DirectFeatureOrchestrator(db);
  
  // Test file path (change this to a real file on your system)
  const testFile = '/home/josh/Projects/mcp-feature-store/package.json';
  
  logger.info('Testing extraction modes for file:', { file: testFile });
  
  // Test minimal mode
  logger.info('\n=== Testing MINIMAL mode ===');
  const minimalFeatures = await orchestrator.extractFeatures(testFile, {
    mode: 'minimal',
    force: true
  });
  logger.info('Minimal mode extracted features:', {
    count: minimalFeatures.length,
    keys: minimalFeatures.map(f => f.featureKey)
  });
  
  // Clear database for next test - delete all rows
  const rawDb2 = new Database(testDbPath);
  rawDb2.exec('DELETE FROM features; DELETE FROM resources;');
  rawDb2.close();
  
  // Test standard mode
  logger.info('\n=== Testing STANDARD mode ===');
  const standardFeatures = await orchestrator.extractFeatures(testFile, {
    mode: 'standard',
    force: true
  });
  logger.info('Standard mode extracted features:', {
    count: standardFeatures.length,
    keys: standardFeatures.map(f => f.featureKey)
  });
  
  // Clear database for next test - delete all rows
  const rawDb3 = new Database(testDbPath);
  rawDb3.exec('DELETE FROM features; DELETE FROM resources;');
  rawDb3.close();
  
  // Test maximal mode
  logger.info('\n=== Testing MAXIMAL mode ===');
  const maximalFeatures = await orchestrator.extractFeatures(testFile, {
    mode: 'maximal',
    force: true,
    includeEmbeddings: true
  });
  logger.info('Maximal mode extracted features:', {
    count: maximalFeatures.length,
    keys: maximalFeatures.map(f => f.featureKey)
  });
  
  // Test updateMissing functionality
  logger.info('\n=== Testing updateMissing ===');
  
  // First extract with minimal mode
  await orchestrator.extractFeatures(testFile, {
    mode: 'minimal',
    force: true
  });
  
  // Then update with standard mode (should only add missing features)
  const updatedFeatures = await orchestrator.extractFeatures(testFile, {
    mode: 'standard',
    updateMissing: true
  });
  
  logger.info('Updated features (should include standard features not in minimal):', {
    count: updatedFeatures.length,
    keys: updatedFeatures.map(f => f.featureKey)
  });
  
  // Query all features to see what we have
  const allFeatures = await db.queryFeatures({ url: testFile });
  logger.info('All features in database after update:', {
    count: allFeatures.length,
    keys: allFeatures.map(f => f.featureKey)
  });
  
  await db.close();
  
  // Clean up test database
  try {
    const { unlinkSync } = await import('fs');
    unlinkSync(testDbPath);
    unlinkSync(testDbPath + '-shm');
    unlinkSync(testDbPath + '-wal');
  } catch (e) {
    // Ignore cleanup errors
  }
}

testExtractionModes().catch(error => {
  logger.error('Test failed:', error);
  process.exit(1);
});