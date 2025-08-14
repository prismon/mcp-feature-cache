#!/usr/bin/env tsx

/**
 * Manual script to populate the feature store database
 * Usage:
 *   npx tsx scripts/populate-db.ts /path/to/image.jpg
 *   npx tsx scripts/populate-db.ts /path/to/directory
 *   npx tsx scripts/populate-db.ts https://example.com/image.jpg
 */

import { FeatureDatabase } from '../src/db/database.js';
import { ResourceLoader } from '../src/core/resource-loader.js';
import { FeatureType, ResourceType } from '../src/types/index.js';
import sharp from 'sharp';
import { readdir, stat } from 'fs/promises';
import { join, extname, basename } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { existsSync } from 'fs';

class ManualFeatureExtractor {
  private db: FeatureDatabase;
  private loader: ResourceLoader;

  constructor() {
    this.db = new FeatureDatabase();
    this.loader = new ResourceLoader();
  }

  async processResource(resourcePath: string) {
    console.log(`\n📁 Processing: ${resourcePath}`);
    
    try {
      // Load the resource
      const resource = await this.loader.load(resourcePath);
      console.log(`   Type: ${resource.type}`);
      console.log(`   MIME: ${resource.mimeType}`);
      console.log(`   Size: ${(resource.size! / 1024).toFixed(2)} KB`);

      // Save resource to database
      await this.db.upsertResource({
        url: resource.url,
        type: resource.type,
        lastProcessed: Math.floor(Date.now() / 1000),
        checksum: resource.checksum,
        size: resource.size,
        mimeType: resource.mimeType
      });

      // Extract features based on content type
      if (resource.mimeType?.startsWith('image/')) {
        await this.extractImageFeatures(resource.url, resource.content);
      } else if (resource.mimeType?.startsWith('text/')) {
        await this.extractTextFeatures(resource.url, resource.content);
      } else {
        console.log('   ⚠️  Unsupported content type');
      }

      console.log(`   ✅ Successfully processed`);
    } catch (error: any) {
      console.error(`   ❌ Error: ${error.message}`);
    }
  }

  private async extractImageFeatures(resourceUrl: string, buffer: Buffer) {
    const features = [];
    
    try {
      // Get metadata
      const metadata = await sharp(buffer).metadata();
      
      // Generate thumbnails
      const thumbnailSmall = await sharp(buffer)
        .resize(150, 150, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
      
      const thumbnailMedium = await sharp(buffer)
        .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
      
      const thumbnailLarge = await sharp(buffer)
        .resize(1920, 1080, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();

      // Get color stats
      const stats = await sharp(buffer).stats();
      
      features.push(
        {
          key: 'image.thumbnail.small',
          value: thumbnailSmall.toString('base64'),
          type: FeatureType.BINARY,
          ttl: 86400,
          extractorTool: 'manual-script',
          metadata: { dimensions: '150x150', format: 'png' }
        },
        {
          key: 'image.thumbnail.medium',
          value: thumbnailMedium.toString('base64'),
          type: FeatureType.BINARY,
          ttl: 86400,
          extractorTool: 'manual-script',
          metadata: { dimensions: '400x400', format: 'png' }
        },
        {
          key: 'image.thumbnail.large',
          value: thumbnailLarge.toString('base64'),
          type: FeatureType.BINARY,
          ttl: 86400,
          extractorTool: 'manual-script',
          metadata: { dimensions: '1920x1080', format: 'png' }
        },
        {
          key: 'image.dimensions',
          value: { width: metadata.width, height: metadata.height },
          type: FeatureType.JSON,
          ttl: 86400,
          extractorTool: 'manual-script'
        },
        {
          key: 'image.format',
          value: metadata.format || 'unknown',
          type: FeatureType.TEXT,
          ttl: 86400,
          extractorTool: 'manual-script'
        },
        {
          key: 'image.dominant_colors',
          value: {
            channels: stats.channels.map(ch => ({
              mean: Math.round(ch.mean),
              min: ch.min,
              max: ch.max
            }))
          },
          type: FeatureType.JSON,
          ttl: 86400,
          extractorTool: 'manual-script'
        }
      );

      await this.db.storeFeatures(resourceUrl, features);
      console.log(`   📊 Extracted ${features.length} image features`);
    } catch (error: any) {
      console.error(`   ❌ Image extraction failed: ${error.message}`);
    }
  }

  private async extractTextFeatures(resourceUrl: string, buffer: Buffer) {
    const text = buffer.toString('utf-8');
    const lines = text.split('\n');
    const words = text.split(/\s+/).filter(w => w.length > 0);
    
    const features = [
      {
        key: 'text.content',
        value: text.substring(0, 10000), // First 10k chars
        type: FeatureType.TEXT,
        ttl: 86400,
        extractorTool: 'manual-script'
      },
      {
        key: 'text.word_count',
        value: words.length,
        type: FeatureType.NUMBER,
        ttl: 86400,
        extractorTool: 'manual-script'
      },
      {
        key: 'text.line_count',
        value: lines.length,
        type: FeatureType.NUMBER,
        ttl: 86400,
        extractorTool: 'manual-script'
      },
      {
        key: 'text.char_count',
        value: text.length,
        type: FeatureType.NUMBER,
        ttl: 86400,
        extractorTool: 'manual-script'
      }
    ];

    await this.db.storeFeatures(resourceUrl, features);
    console.log(`   📊 Extracted ${features.length} text features`);
  }

  async processDirectory(dirPath: string) {
    const files = await readdir(dirPath);
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
    const textExtensions = ['.txt', '.md', '.json', '.html', '.css', '.js', '.ts'];
    
    let processed = 0;
    
    for (const file of files) {
      const fullPath = join(dirPath, file);
      const stats = await stat(fullPath);
      
      if (stats.isDirectory()) {
        continue; // Skip directories for now
      }
      
      const ext = extname(file).toLowerCase();
      if (imageExtensions.includes(ext) || textExtensions.includes(ext)) {
        await this.processResource(`file://${fullPath}`);
        processed++;
      }
    }
    
    return processed;
  }

  async showStats() {
    const stats = await this.db.getStats();
    console.log('\n📊 Database Statistics:');
    console.log(`   Total Resources: ${stats.totalResources}`);
    console.log(`   Total Features: ${stats.totalFeatures}`);
    console.log(`   Expired Features: ${stats.expiredFeatures}`);
  }

  close() {
    this.db.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help')) {
    console.log(`
MCP Feature Store - Manual Database Population

Usage:
  npx tsx scripts/populate-db.ts <path>           Process a single file or URL
  npx tsx scripts/populate-db.ts <directory>      Process all images/text in directory
  npx tsx scripts/populate-db.ts --stats          Show database statistics
  
Examples:
  npx tsx scripts/populate-db.ts /path/to/image.jpg
  npx tsx scripts/populate-db.ts https://example.com/image.png
  npx tsx scripts/populate-db.ts ./my-images/
  
Supported formats:
  Images: jpg, jpeg, png, gif, webp, bmp
  Text: txt, md, json, html, css, js, ts
`);
    process.exit(0);
  }

  const extractor = new ManualFeatureExtractor();

  try {
    if (args[0] === '--stats') {
      await extractor.showStats();
    } else {
      const path = args[0];
      
      // Check if it's a directory
      if (existsSync(path) && (await stat(path)).isDirectory()) {
        console.log(`📂 Processing directory: ${path}`);
        const count = await extractor.processDirectory(path);
        console.log(`\n✅ Processed ${count} files`);
      } else {
        // Process as single file or URL
        await extractor.processResource(path);
      }
      
      await extractor.showStats();
    }
  } catch (error: any) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    extractor.close();
  }
}

main();