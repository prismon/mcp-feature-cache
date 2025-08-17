#!/usr/bin/env tsx

import { DirectFeatureOrchestrator } from '../src/core/direct-orchestrator.js';
import { FeatureDatabase } from '../src/db/database.js';
import Database from 'better-sqlite3';

async function testExtractionModes() {
  const testDbPath = '/tmp/test-extraction-modes.db';
  
  // Initialize database with schema
  const rawDb = new Database(testDbPath);
  
  const schema = `
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
  `;
  
  rawDb.exec(schema);
  rawDb.close();
  
  const db = new FeatureDatabase(testDbPath);
  const orchestrator = new DirectFeatureOrchestrator(db);
  
  const testFile = '/home/josh/Projects/mcp-feature-store/package.json';
  
  console.log('Testing extraction modes for file:', testFile);
  
  // Test minimal mode
  console.log('\n=== Testing MINIMAL mode ===');
  const minimalFeatures = await orchestrator.extractFeatures(testFile, {
    mode: 'minimal',
    force: true,
    skipDirectoryIndexing: true
  });
  console.log('Minimal mode extracted features:');
  console.log('  Count:', minimalFeatures.length);
  console.log('  Keys:', minimalFeatures.map(f => f.featureKey).join(', '));
  
  // Clear database
  const rawDb2 = new Database(testDbPath);
  rawDb2.exec('DELETE FROM features; DELETE FROM resources;');
  rawDb2.close();
  
  // Test standard mode
  console.log('\n=== Testing STANDARD mode ===');
  const standardFeatures = await orchestrator.extractFeatures(testFile, {
    mode: 'standard',
    force: true,
    skipDirectoryIndexing: true
  });
  console.log('Standard mode extracted features:');
  console.log('  Count:', standardFeatures.length);
  console.log('  Keys:', standardFeatures.map(f => f.featureKey).join(', '));
  
  // Clear database
  const rawDb3 = new Database(testDbPath);
  rawDb3.exec('DELETE FROM features; DELETE FROM resources;');
  rawDb3.close();
  
  // Test maximal mode
  console.log('\n=== Testing MAXIMAL mode ===');
  const maximalFeatures = await orchestrator.extractFeatures(testFile, {
    mode: 'maximal',
    force: true,
    skipDirectoryIndexing: true
  });
  console.log('Maximal mode extracted features:');
  console.log('  Count:', maximalFeatures.length);
  console.log('  Keys:', maximalFeatures.map(f => f.featureKey).join(', '));
  
  // Test updateMissing functionality
  console.log('\n=== Testing updateMissing ===');
  
  // Clear and extract with minimal mode
  const rawDb4 = new Database(testDbPath);
  rawDb4.exec('DELETE FROM features; DELETE FROM resources;');
  rawDb4.close();
  
  await orchestrator.extractFeatures(testFile, {
    mode: 'minimal',
    force: true,
    skipDirectoryIndexing: true
  });
  
  // Then update with maximal mode (should only add missing features)
  const updatedFeatures = await orchestrator.extractFeatures(testFile, {
    mode: 'maximal',
    updateMissing: true,
    skipDirectoryIndexing: true
  });
  
  console.log('Updated features (new features added by maximal mode):');
  console.log('  Count:', updatedFeatures.length);
  console.log('  Keys:', updatedFeatures.map(f => f.featureKey).join(', '));
  
  // Query all features to see what we have
  const allFeatures = await db.queryFeatures({ url: testFile });
  console.log('\nAll features in database after update:');
  console.log('  Total Count:', allFeatures.length);
  console.log('  All Keys:', allFeatures.map(f => f.featureKey).join(', '));
  
  await db.close();
  
  // Clean up
  try {
    const { unlinkSync } = await import('fs');
    unlinkSync(testDbPath);
    unlinkSync(testDbPath + '-shm');
    unlinkSync(testDbPath + '-wal');
  } catch (e) {
    // Ignore cleanup errors
  }
  
  console.log('\n✅ Test completed successfully!');
}

testExtractionModes().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});