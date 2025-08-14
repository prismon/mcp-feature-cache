#!/usr/bin/env tsx

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env.DATABASE_PATH || join(__dirname, '../../data/features.db');

console.log('Initializing database at:', DB_PATH);

try {
  mkdirSync(dirname(DB_PATH), { recursive: true });
} catch (error) {
  // Directory might already exist
}

const db = new Database(DB_PATH);

const schema = `
-- Resources table
CREATE TABLE IF NOT EXISTS resources (
  url TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('file', 'url')),
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

-- Extractor registry for MCP tools
CREATE TABLE IF NOT EXISTS extractor_registry (
  tool_name TEXT PRIMARY KEY,
  server_url TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  feature_keys TEXT NOT NULL,
  priority INTEGER DEFAULT 100,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_features_resource ON features(resource_url);
CREATE INDEX IF NOT EXISTS idx_features_expires ON features(expires_at);
CREATE INDEX IF NOT EXISTS idx_features_key ON features(feature_key);
CREATE INDEX IF NOT EXISTS idx_features_extractor ON features(extractor_tool);
CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
CREATE INDEX IF NOT EXISTS idx_registry_enabled ON extractor_registry(enabled);

-- Create triggers for updated_at
CREATE TRIGGER IF NOT EXISTS update_resources_timestamp 
  AFTER UPDATE ON resources
  BEGIN
    UPDATE resources SET updated_at = unixepoch() WHERE url = NEW.url;
  END;

CREATE TRIGGER IF NOT EXISTS update_registry_timestamp 
  AFTER UPDATE ON extractor_registry
  BEGIN
    UPDATE extractor_registry SET updated_at = unixepoch() WHERE tool_name = NEW.tool_name;
  END;
`;

try {
  db.exec(schema);
  
  // Insert default extractors
  const insertExtractor = db.prepare(`
    INSERT OR REPLACE INTO extractor_registry 
    (tool_name, server_url, capabilities, feature_keys, priority, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const defaultExtractors = [
    {
      tool_name: 'extract_text_features',
      server_url: 'stdio://extractors/text',
      capabilities: JSON.stringify(['text/plain', 'text/html', 'text/markdown']),
      feature_keys: JSON.stringify([
        'text.content',
        'text.summary',
        'text.keywords',
        'text.language',
        'text.word_count'
      ]),
      priority: 100,
      enabled: 1
    },
    {
      tool_name: 'extract_image_features',
      server_url: 'stdio://extractors/image',
      capabilities: JSON.stringify(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
      feature_keys: JSON.stringify([
        'image.thumbnail.small',
        'image.thumbnail.medium',
        'image.thumbnail.timeline',
        'image.dimensions',
        'image.format'
      ]),
      priority: 100,
      enabled: 1
    },
    {
      tool_name: 'generate_embeddings',
      server_url: 'stdio://extractors/embedding',
      capabilities: JSON.stringify(['text/plain', 'text/html', 'text/markdown']),
      feature_keys: JSON.stringify([
        'embedding.vector',
        'embedding.model',
        'embedding.dimensions'
      ]),
      priority: 200,
      enabled: 1
    }
  ];

  for (const extractor of defaultExtractors) {
    insertExtractor.run(
      extractor.tool_name,
      extractor.server_url,
      extractor.capabilities,
      extractor.feature_keys,
      extractor.priority,
      extractor.enabled
    );
  }

  console.log('✅ Database initialized successfully');
  
  // Show table info
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('\nCreated tables:', tables.map(t => t.name).join(', '));
  
  const extractorCount = db.prepare('SELECT COUNT(*) as count FROM extractor_registry').get();
  console.log(`Registered ${extractorCount.count} default extractors`);
  
} catch (error) {
  console.error('❌ Error initializing database:', error);
  process.exit(1);
} finally {
  db.close();
}