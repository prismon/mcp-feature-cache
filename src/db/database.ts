import Database from 'better-sqlite3';
import { Feature, Resource, ExtractorRegistry, FeatureType, ResourceType } from '../types/index.js';
import { FeatureStoreError, ErrorCode } from '../types/errors.js';
import { v4 as uuidv4 } from 'uuid';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const logger = createLogger('database');

export class FeatureDatabase {
  private db: Database.Database;
  
  constructor(dbPath?: string) {
    const path = dbPath || process.env.DATABASE_PATH || join(__dirname, '../../data/features.db');
    this.db = new Database(path);
    
    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
  }

  // Resource operations
  async upsertResource(resource: Resource): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO resources (url, type, last_processed, checksum, size, mime_type)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        last_processed = excluded.last_processed,
        checksum = excluded.checksum,
        size = excluded.size,
        mime_type = excluded.mime_type
    `);
    
    stmt.run(
      resource.url,
      resource.type,
      resource.lastProcessed,
      resource.checksum || null,
      resource.size || null,
      resource.mimeType || null
    );
  }

  async getResource(url: string): Promise<Resource | null> {
    const stmt = this.db.prepare('SELECT * FROM resources WHERE url = ?');
    const row = stmt.get(url) as any;
    
    if (!row) return null;
    
    return {
      url: row.url,
      type: row.type as ResourceType,
      lastProcessed: row.last_processed,
      checksum: row.checksum,
      size: row.size,
      mimeType: row.mime_type,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async getResources(params?: { url?: string; type?: string }): Promise<Resource[]> {
    let query = 'SELECT * FROM resources WHERE 1=1';
    const bindings: any[] = [];
    
    if (params?.url) {
      query += ' AND url = ?';
      bindings.push(params.url);
    }
    
    if (params?.type) {
      query += ' AND type = ?';
      bindings.push(params.type);
    }
    
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...bindings) as any[];
    
    return rows.map(row => ({
      url: row.url,
      type: row.type as ResourceType,
      lastProcessed: row.last_processed,
      checksum: row.checksum,
      size: row.size,
      mimeType: row.mime_type,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  // Feature operations
  async storeFeatures(resourceUrl: string, features: Array<{
    key: string;
    value: any;
    type: FeatureType;
    ttl?: number;
    extractorTool: string;
    metadata?: Record<string, any>;
  }>): Promise<void> {
    const insertStmt = this.db.prepare(`
      INSERT INTO features (
        id, resource_url, feature_key, value, value_type,
        generated_at, ttl, expires_at, extractor_tool, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(resource_url, feature_key) DO UPDATE SET
        value = excluded.value,
        value_type = excluded.value_type,
        generated_at = excluded.generated_at,
        ttl = excluded.ttl,
        expires_at = excluded.expires_at,
        extractor_tool = excluded.extractor_tool,
        metadata = excluded.metadata
    `);
    
    const transaction = this.db.transaction((features: any[]) => {
      for (const feature of features) {
        const now = Math.floor(Date.now() / 1000);
        const ttl = feature.ttl || 3600;
        const expiresAt = now + ttl;
        
        // Convert value to string (base64 for binary)
        let valueStr: string;
        if (feature.type === FeatureType.BINARY || feature.type === FeatureType.EMBEDDING) {
          valueStr = Buffer.isBuffer(feature.value) 
            ? feature.value.toString('base64')
            : feature.value;
        } else if (feature.type === FeatureType.JSON) {
          valueStr = JSON.stringify(feature.value);
        } else {
          valueStr = String(feature.value);
        }
        
        insertStmt.run(
          uuidv4(),
          resourceUrl,
          feature.key,
          valueStr,
          feature.type,
          now,
          ttl,
          expiresAt,
          feature.extractorTool,
          feature.metadata ? JSON.stringify(feature.metadata) : null
        );
      }
    });
    
    transaction(features);
  }

  async queryFeatures(params: {
    url?: string;
    featureKeys?: string[];
    extractors?: string[];
    includeExpired?: boolean;
  }): Promise<Feature[]> {
    let query = 'SELECT * FROM features WHERE 1=1';
    const bindings: any[] = [];
    
    if (params.url) {
      query += ' AND resource_url = ?';
      bindings.push(params.url);
    }
    
    if (params.featureKeys && params.featureKeys.length > 0) {
      const placeholders = params.featureKeys.map(() => '?').join(',');
      query += ` AND feature_key IN (${placeholders})`;
      bindings.push(...params.featureKeys);
    }
    
    if (params.extractors && params.extractors.length > 0) {
      const placeholders = params.extractors.map(() => '?').join(',');
      query += ` AND extractor_tool IN (${placeholders})`;
      bindings.push(...params.extractors);
    }
    
    if (!params.includeExpired) {
      query += ' AND expires_at > ?';
      bindings.push(Math.floor(Date.now() / 1000));
    }
    
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...bindings) as any[];
    
    return rows.map(row => ({
      id: row.id,
      resourceUrl: row.resource_url,
      featureKey: row.feature_key,
      value: row.value,
      valueType: row.value_type as FeatureType,
      generatedAt: row.generated_at,
      ttl: row.ttl,
      expiresAt: row.expires_at,
      extractorTool: row.extractor_tool,
      metadata: row.metadata ? JSON.parse(row.metadata) : {}
    }));
  }

  async updateTTL(resourceUrl: string, featureKey: string, ttl: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + ttl;
    
    const stmt = this.db.prepare(`
      UPDATE features 
      SET ttl = ?, expires_at = ?
      WHERE resource_url = ? AND feature_key = ?
    `);
    
    const result = stmt.run(ttl, expiresAt, resourceUrl, featureKey);
    
    if (result.changes === 0) {
      throw new FeatureStoreError(
        ErrorCode.RESOURCE_NOT_FOUND,
        `Feature not found: ${resourceUrl}/${featureKey}`
      );
    }
  }

  async cleanExpiredFeatures(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare('DELETE FROM features WHERE expires_at < ?');
    const result = stmt.run(now);
    return result.changes;
  }

  // Extractor registry operations
  async registerExtractor(extractor: Omit<ExtractorRegistry, 'createdAt' | 'updatedAt'>): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO extractor_registry
      (tool_name, server_url, capabilities, feature_keys, priority, enabled)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      extractor.toolName,
      extractor.serverUrl,
      JSON.stringify(extractor.capabilities),
      JSON.stringify(extractor.featureKeys),
      extractor.priority,
      extractor.enabled ? 1 : 0
    );
  }

  async getExtractors(params?: {
    enabled?: boolean;
    capability?: string;
  }): Promise<ExtractorRegistry[]> {
    let query = 'SELECT * FROM extractor_registry WHERE 1=1';
    const bindings: any[] = [];
    
    if (params?.enabled !== undefined) {
      query += ' AND enabled = ?';
      bindings.push(params.enabled ? 1 : 0);
    }
    
    query += ' ORDER BY priority ASC, tool_name ASC';
    
    const stmt = this.db.prepare(query);
    const rows = stmt.all(...bindings) as any[];
    
    let extractors = rows.map(row => ({
      toolName: row.tool_name,
      serverUrl: row.server_url,
      capabilities: JSON.parse(row.capabilities),
      featureKeys: JSON.parse(row.feature_keys),
      priority: row.priority,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
    
    // Filter by capability if specified
    if (params?.capability) {
      extractors = extractors.filter(e => 
        e.capabilities.includes(params.capability!)
      );
    }
    
    return extractors;
  }

  async getExtractor(toolName: string): Promise<ExtractorRegistry | null> {
    const stmt = this.db.prepare('SELECT * FROM extractor_registry WHERE tool_name = ?');
    const row = stmt.get(toolName) as any;
    
    if (!row) return null;
    
    return {
      toolName: row.tool_name,
      serverUrl: row.server_url,
      capabilities: JSON.parse(row.capabilities),
      featureKeys: JSON.parse(row.feature_keys),
      priority: row.priority,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async setExtractorEnabled(toolName: string, enabled: boolean): Promise<void> {
    const stmt = this.db.prepare('UPDATE extractor_registry SET enabled = ? WHERE tool_name = ?');
    const result = stmt.run(enabled ? 1 : 0, toolName);
    
    if (result.changes === 0) {
      throw new FeatureStoreError(
        ErrorCode.EXTRACTOR_NOT_FOUND,
        `Extractor not found: ${toolName}`
      );
    }
  }

  // Cleanup and maintenance
  close(): void {
    this.db.close();
  }

  // Statistics
  async getStats(): Promise<{
    totalResources: number;
    totalFeatures: number;
    expiredFeatures: number;
    activeExtractors: number;
  }> {
    const now = Math.floor(Date.now() / 1000);
    
    const totalResources = this.db.prepare('SELECT COUNT(*) as count FROM resources').get() as any;
    const totalFeatures = this.db.prepare('SELECT COUNT(*) as count FROM features').get() as any;
    const expiredFeatures = this.db.prepare('SELECT COUNT(*) as count FROM features WHERE expires_at < ?').get(now) as any;
    const activeExtractors = this.db.prepare('SELECT COUNT(*) as count FROM extractor_registry WHERE enabled = 1').get() as any;
    
    return {
      totalResources: totalResources.count,
      totalFeatures: totalFeatures.count,
      expiredFeatures: expiredFeatures.count,
      activeExtractors: activeExtractors.count
    };
  }
}