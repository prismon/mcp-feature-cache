#!/usr/bin/env tsx

import { DirectFeatureOrchestrator } from '../src/core/direct-orchestrator.js';
import { FeatureDatabase } from '../src/db/database.js';
import Database from 'better-sqlite3';

async function testRecursiveExtraction() {
  const testDbPath = '/tmp/test-recursive.db';
  
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
  
  // Test with the scripts directory which has subdirectories
  const testDir = '/home/josh/Projects/mcp-feature-store/src';
  
  console.log(`Testing recursive extraction for directory: ${testDir}`);
  console.log('Using minimal mode to focus on directory metadata\n');
  
  // Extract with minimal mode
  console.log('Starting extraction...');
  const features = await orchestrator.extractFeatures(testDir, {
    mode: 'minimal',
    force: true
  });
  console.log('Extraction complete.');
  
  console.log(`Extracted ${features.length} features for the root directory`);
  console.log('Root directory features:', features.map(f => f.featureKey).join(', '));
  console.log();
  
  // Query all directory resources to see what was indexed
  const allResources = await db.queryFeatures({ });
  
  console.log(`Total features in database: ${allResources.length}`);
  console.log('Unique resource URLs:', [...new Set(allResources.map(f => f.resourceUrl))].join('\n  '));
  console.log();
  
  // Filter to only show directory features
  const directoryFeatures = allResources.filter(f => 
    f.featureKey.startsWith('directory.')
  );
  
  // Group by resource URL to show each directory
  const directoriesByUrl = new Map<string, any[]>();
  for (const feature of directoryFeatures) {
    if (!directoriesByUrl.has(feature.resourceUrl)) {
      directoriesByUrl.set(feature.resourceUrl, []);
    }
    directoriesByUrl.get(feature.resourceUrl)!.push(feature);
  }
  
  console.log(`Found ${directoriesByUrl.size} directories with metadata:\n`);
  
  // Display info for each directory, sorted by path
  const sortedUrls = Array.from(directoriesByUrl.keys()).sort();
  for (const url of sortedUrls) {
    const features = directoriesByUrl.get(url)!;
    const path = url.replace('file://', '');
    const fileCount = features.find(f => f.featureKey === 'directory.file_count');
    const subdirCount = features.find(f => f.featureKey === 'directory.subdirectory_count');
    const totalSize = features.find(f => f.featureKey === 'directory.total_size');
    const metadata = features.find(f => f.featureKey === 'directory.metadata');
    
    const isRoot = path === testDir;
    console.log(`📁 ${path}${isRoot ? ' (ROOT)' : ''}`);
    if (fileCount) console.log(`   Files: ${fileCount.value}`);
    if (subdirCount) console.log(`   Subdirectories: ${subdirCount.value}`);
    if (totalSize) {
      const sizeInMB = (parseInt(totalSize.value) / (1024 * 1024)).toFixed(2);
      console.log(`   Total Size: ${sizeInMB} MB`);
    }
    
    // Parse and show some metadata details
    if (metadata) {
      try {
        const meta = JSON.parse(metadata.value);
        if (meta.largestFiles && meta.largestFiles.length > 0) {
          console.log(`   Largest file: ${meta.largestFiles[0].name} (${meta.largestFiles[0].sizeFormatted})`);
        }
      } catch (e) {
        // Ignore JSON parse errors
      }
    }
    console.log();
  }
  
  await db.close();
  
  // Don't clean up - keep database for inspection
  console.log(`\n✅ Test completed! Database saved at: ${testDbPath}`);
}

testRecursiveExtraction().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});