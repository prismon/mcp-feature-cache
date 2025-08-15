import pLimit from 'p-limit';
import { FeatureDatabase } from '../db/database.js';
import { 
  Feature, 
  Resource, 
  FeatureType, 
  ResourceType,
  StreamUpdate
} from '../types/index.js';
import { FeatureStoreError, ErrorCode } from '../types/errors.js';
import { createLogger } from '../utils/logger.js';
import { ResourceLoader } from './resource-loader.js';
import { EmbeddingExtractor } from '../extractors/embedding-extractor.js';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const execAsync = promisify(exec);
const logger = createLogger('direct-orchestrator');

interface ExtractOptions {
  extractors?: string[];
  ttl?: number;
  force?: boolean;
  includeEmbeddings?: boolean;
}

export class DirectFeatureOrchestrator {
  private db: FeatureDatabase;
  private resourceLoader: ResourceLoader;
  private embeddingExtractor: EmbeddingExtractor;
  private concurrencyLimit = pLimit(5);
  private tempDir: string;

  constructor(db: FeatureDatabase) {
    this.db = db;
    this.resourceLoader = new ResourceLoader();
    this.embeddingExtractor = new EmbeddingExtractor();
    this.tempDir = join(tmpdir(), 'mcp-feature-store');
    this.initTempDir();
  }

  private async initTempDir() {
    try {
      await mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      logger.error('Failed to create temp directory:', error);
    }
  }

  async extractFeatures(
    resourceUrl: string, 
    options: ExtractOptions = {}
  ): Promise<Feature[]> {
    const timer = logger.startTimer('extract-features-total');
    
    logger.info('Starting feature extraction', {
      resourceUrl,
      options,
      force: options.force,
      includeEmbeddings: options.includeEmbeddings
    });
    
    try {
      // Load resource
      logger.debug('Loading resource', { url: resourceUrl });
      const loadTimer = logger.startTimer('resource-load');
      const resource = await this.resourceLoader.load(resourceUrl);
      loadTimer();
      
      logger.verbose('Resource loaded', {
        url: resource.url,
        type: resource.type,
        size: resource.size,
        mimeType: resource.mimeType,
        checksum: resource.checksum
      });
      
      // Check if we should skip extraction
      if (!options.force) {
        logger.trace('Checking for cached features', { url: resourceUrl });
        const existingResource = await this.db.getResource(resourceUrl);
        
        if (existingResource) {
          logger.verbose('Found existing resource', {
            url: resourceUrl,
            checksum: existingResource.checksum,
            lastProcessed: existingResource.lastProcessed
          });
          
          if (existingResource.checksum === resource.checksum) {
            const existingFeatures = await this.db.queryFeatures({ url: resourceUrl });
            if (existingFeatures.length > 0) {
              timer();
              logger.info(`Using cached features for ${resourceUrl}`, {
                featureCount: existingFeatures.length,
                cached: true
              });
              return existingFeatures;
            }
          } else {
            logger.debug('Resource checksum changed, re-extracting', {
              oldChecksum: existingResource.checksum,
              newChecksum: resource.checksum
            });
          }
        } else {
          logger.trace('No existing resource found', { url: resourceUrl });
        }
      } else {
        logger.debug('Force extraction enabled, skipping cache check');
      }

      // Save/update resource
      logger.trace('Upserting resource in database', { url: resourceUrl });
      const dbTimer = logger.startTimer('db-upsert-resource');
      await this.db.upsertResource({
        url: resourceUrl,
        type: resource.type,
        lastProcessed: Math.floor(Date.now() / 1000),
        checksum: resource.checksum,
        size: resource.size,
        mimeType: resource.mimeType
      });
      dbTimer();
      logger.verbose('Resource saved to database', { url: resourceUrl });

      // Extract features based on MIME type
      let features: Feature[] = [];
      const mimeType = resource.mimeType || 'unknown';
      
      logger.debug('Selecting extractor based on MIME type', { 
        mimeType,
        url: resourceUrl 
      });
      
      if (resource.mimeType?.startsWith('image/')) {
        logger.trace('Using image extractor', { mimeType });
        const imageTimer = logger.startTimer('extract-image-features');
        features = await this.extractImageFeatures(resource, options.ttl || 86400);
        imageTimer();
      } else if (resource.mimeType?.startsWith('video/')) {
        logger.trace('Using video extractor', { mimeType });
        const videoTimer = logger.startTimer('extract-video-features');
        features = await this.extractVideoFeatures(resource, options.ttl || 86400);
        videoTimer();
      } else if (resource.mimeType?.startsWith('text/') || 
                 resource.mimeType === 'application/json' ||
                 resource.mimeType === 'application/javascript' ||
                 resource.mimeType === 'text/typescript') {
        logger.trace('Using text extractor', { mimeType });
        const textTimer = logger.startTimer('extract-text-features');
        features = await this.extractTextFeatures(resource, options.ttl || 86400);
        textTimer();
        
        // Optionally add embeddings for text content
        if (options.includeEmbeddings && this.embeddingExtractor.isAvailable()) {
          try {
            const embeddingFeatures = await this.embeddingExtractor.extractFeatures(resource, options.ttl || 86400);
            features.push(...embeddingFeatures);
            logger.info(`Added ${embeddingFeatures.length} embedding features`);
          } catch (error) {
            logger.warn(`Failed to generate embeddings: ${error}`);
          }
        }
      } else {
        logger.warn(`No built-in extractor for MIME type: ${resource.mimeType}`);
      }

      // Store features in database
      if (features.length > 0) {
        const featuresToStore = features.map(f => ({
          key: f.featureKey,
          value: f.value,
          type: f.valueType,
          ttl: f.ttl,
          extractorTool: 'built-in',
          metadata: f.metadata
        }));

        await this.db.storeFeatures(resourceUrl, featuresToStore);
      }

      return features;
    } catch (error: any) {
      logger.error(`Feature extraction failed for ${resourceUrl}:`, error);
      throw new FeatureStoreError(
        ErrorCode.EXTRACTION_FAILED,
        `Failed to extract features from ${resourceUrl}: ${error.message}`,
        undefined,
        { resourceUrl, error: error.message }
      );
    }
  }

  private async extractImageFeatures(resource: Resource & { content: Buffer }, ttl: number): Promise<Feature[]> {
    const features: Feature[] = [];
    const buffer = resource.content;
    
    // Generate a unique resource ID from the URL or checksum
    const resourceId = resource.checksum?.substring(0, 16) || 
                      resource.url.split('/').pop()?.replace(/\.[^/.]+$/, '') || 
                      uuidv4();
    const serverUrl = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 8080}`;

    try {
      logger.trace('Extracting image features', { url: resource.url, resourceId });
      
      // Get image metadata
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

      // Get color statistics
      const stats = await sharp(buffer).stats();
      const dominantColors = {
        channels: stats.channels.map(ch => ({
          mean: Math.round(ch.mean),
          min: ch.min,
          max: ch.max
        }))
      };

      const now = Math.floor(Date.now() / 1000);

      // Store thumbnails in database but return URLs
      const thumbnailFeatures = [
        {
          key: 'image.thumbnail_small',
          buffer: thumbnailSmall,
          dimensions: '150x150',
          url: `${serverUrl}/thumbnails/${resourceId}/small`
        },
        {
          key: 'image.thumbnail_medium',
          buffer: thumbnailMedium,
          dimensions: '400x400',
          url: `${serverUrl}/thumbnails/${resourceId}/medium`
        },
        {
          key: 'image.thumbnail_large',
          buffer: thumbnailLarge,
          dimensions: '1920x1080',
          url: `${serverUrl}/thumbnails/${resourceId}/large`
        }
      ];
      
      // Store actual image data in database
      for (const thumb of thumbnailFeatures) {
        await this.db.storeFeatures(resource.url, [{
          key: thumb.key,
          value: thumb.buffer.toString('base64'),
          type: FeatureType.BINARY,
          ttl,
          extractorTool: 'built-in',
          metadata: { 
            dimensions: thumb.dimensions, 
            format: 'png',
            resourceId
          }
        }]);
      }
      
      // Return features with URLs instead of inline data
      features.push(
        {
          id: uuidv4(),
          resourceUrl: resource.url,
          featureKey: 'image.thumbnail.small',
          value: `${serverUrl}/thumbnails/${resourceId}/small`,
          valueType: FeatureType.TEXT,
          generatedAt: now,
          ttl,
          expiresAt: now + ttl,
          extractorTool: 'built-in',
          metadata: { 
            dimensions: '150x150', 
            format: 'png',
            mediaType: 'url',
            resourceId
          }
        },
        {
          id: uuidv4(),
          resourceUrl: resource.url,
          featureKey: 'image.thumbnail.medium',
          value: `${serverUrl}/thumbnails/${resourceId}/medium`,
          valueType: FeatureType.TEXT,
          generatedAt: now,
          ttl,
          expiresAt: now + ttl,
          extractorTool: 'built-in',
          metadata: { 
            dimensions: '400x400', 
            format: 'png',
            mediaType: 'url',
            resourceId
          }
        },
        {
          id: uuidv4(),
          resourceUrl: resource.url,
          featureKey: 'image.thumbnail.large',
          value: `${serverUrl}/thumbnails/${resourceId}/large`,
          valueType: FeatureType.TEXT,
          generatedAt: now,
          ttl,
          expiresAt: now + ttl,
          extractorTool: 'built-in',
          metadata: { 
            dimensions: '1920x1080', 
            format: 'png',
            mediaType: 'url',
            resourceId
          }
        },
        {
          id: uuidv4(),
          resourceUrl: resource.url,
          featureKey: 'image.dimensions',
          value: JSON.stringify({ width: metadata.width, height: metadata.height }),
          valueType: FeatureType.JSON,
          generatedAt: now,
          ttl,
          expiresAt: now + ttl,
          extractorTool: 'built-in',
          metadata: {}
        },
        {
          id: uuidv4(),
          resourceUrl: resource.url,
          featureKey: 'image.format',
          value: metadata.format || 'unknown',
          valueType: FeatureType.TEXT,
          generatedAt: now,
          ttl,
          expiresAt: now + ttl,
          extractorTool: 'built-in',
          metadata: {}
        },
        {
          id: uuidv4(),
          resourceUrl: resource.url,
          featureKey: 'image.dominant_colors',
          value: JSON.stringify(dominantColors),
          valueType: FeatureType.JSON,
          generatedAt: now,
          ttl,
          expiresAt: now + ttl,
          extractorTool: 'built-in',
          metadata: {}
        }
      );

      logger.info(`Extracted ${features.length} image features from ${resource.url}`, {
        resourceId,
        featureCount: features.length,
        thumbnailUrls: thumbnailFeatures.map(t => t.url)
      });
    } catch (error: any) {
      logger.error('Image extraction failed:', error);
      throw error;
    }

    return features;
  }

  private async extractVideoFeatures(resource: Resource & { content: Buffer }, ttl: number): Promise<Feature[]> {
    const features: Feature[] = [];
    
    // Generate resource ID
    const resourceId = resource.checksum?.substring(0, 16) || 
                      resource.url.split('/').pop()?.replace(/\.[^/.]+$/, '') || 
                      uuidv4();
    const serverUrl = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 8080}`;
    
    // Check if ffmpeg is available
    try {
      await execAsync('ffmpeg -version');
    } catch {
      logger.warn('ffmpeg not found. Video extraction not available.');
      return features;
    }

    logger.trace('Extracting video features', { url: resource.url, resourceId });
    
    // Save video to temp file
    const tempVideoPath = join(this.tempDir, `${uuidv4()}.video`);
    const snapshots: Array<{ percentage: number; buffer: Buffer; url: string }> = [];
    
    try {
      await writeFile(tempVideoPath, resource.content);

      // Get video info
      const { stdout } = await execAsync(
        `ffprobe -v quiet -print_format json -show_format -show_streams "${tempVideoPath}"`
      );

      const info = JSON.parse(stdout);
      const videoStream = info.streams?.find((s: any) => s.codec_type === 'video');

      if (!videoStream) {
        throw new Error('No video stream found');
      }

      const duration = parseFloat(info.format?.duration || '0');
      const width = videoStream.width || 0;
      const height = videoStream.height || 0;

      const now = Math.floor(Date.now() / 1000);

      // Extract snapshots at 10% intervals (0%, 10%, 20%, ..., 90%)
      for (let percentage = 0; percentage <= 90; percentage += 10) {
        const timestamp = (duration * percentage) / 100;
        const snapshotPath = join(this.tempDir, `${uuidv4()}.png`);
        
        logger.trace(`Extracting video snapshot at ${percentage}%`, { timestamp });
        
        await execAsync(
          `ffmpeg -ss ${timestamp} -i "${tempVideoPath}" -vframes 1 -vf "scale='min(400,iw)':'min(400,ih)':force_original_aspect_ratio=decrease" -f image2 "${snapshotPath}" -y`
        );

        const snapshotBuffer = await sharp(snapshotPath).png().toBuffer();
        const snapshotUrl = `${serverUrl}/media/${resourceId}/video.snapshot_${percentage}`;
        
        snapshots.push({ percentage, buffer: snapshotBuffer, url: snapshotUrl });
        
        // Store snapshot in database
        await this.db.storeFeatures(resource.url, [{
          key: `video.snapshot_${percentage}`,
          value: snapshotBuffer.toString('base64'),
          type: FeatureType.BINARY,
          ttl,
          extractorTool: 'built-in',
          metadata: { 
            timestamp, 
            percentage,
            format: 'png',
            resourceId
          }
        }]);
        
        // Clean up temp snapshot file
        await unlink(snapshotPath).catch(() => {});
      }

      // Add snapshot URLs as features
      for (const snapshot of snapshots) {
        features.push({
          id: uuidv4(),
          resourceUrl: resource.url,
          featureKey: `video.snapshot_${snapshot.percentage}`,
          value: snapshot.url,
          valueType: FeatureType.TEXT,
          generatedAt: now,
          ttl,
          expiresAt: now + ttl,
          extractorTool: 'built-in',
          metadata: { 
            percentage: snapshot.percentage,
            format: 'png',
            mediaType: 'url',
            resourceId
          }
        });
      }
      
      // Add main thumbnail (50% mark)
      features.push(
        {
          id: uuidv4(),
          resourceUrl: resource.url,
          featureKey: 'video.dimensions',
          value: JSON.stringify({ width, height }),
          valueType: FeatureType.JSON,
          generatedAt: now,
          ttl,
          expiresAt: now + ttl,
          extractorTool: 'built-in',
          metadata: {}
        },
        {
          id: uuidv4(),
          resourceUrl: resource.url,
          featureKey: 'video.duration',
          value: String(duration),
          valueType: FeatureType.NUMBER,
          generatedAt: now,
          ttl,
          expiresAt: now + ttl,
          extractorTool: 'built-in',
          metadata: { unit: 'seconds' }
        }
      );

      logger.verbose('Video snapshots extracted', {
        resourceId,
        snapshotCount: snapshots.length,
        percentages: snapshots.map(s => `${s.percentage}%`)
      });

      logger.info(`Extracted ${features.length} video features from ${resource.url}`, {
        resourceId,
        featureCount: features.length,
        snapshotCount: snapshots.length
      });
    } catch (error: any) {
      logger.error('Video extraction failed:', error);
    } finally {
      // Clean up temp video file
      await unlink(tempVideoPath).catch(() => {});
    }

    return features;
  }

  private async extractTextFeatures(resource: Resource & { content: Buffer }, ttl: number): Promise<Feature[]> {
    const features: Feature[] = [];
    const text = resource.content.toString('utf-8');
    const lines = text.split('\n');
    const words = text.split(/\s+/).filter(w => w.length > 0);
    
    const now = Math.floor(Date.now() / 1000);

    features.push(
      {
        id: uuidv4(),
        resourceUrl: resource.url,
        featureKey: 'text.content',
        value: text.substring(0, 10000), // First 10k chars
        valueType: FeatureType.TEXT,
        generatedAt: now,
        ttl,
        expiresAt: now + ttl,
        extractorTool: 'built-in',
        metadata: {}
      },
      {
        id: uuidv4(),
        resourceUrl: resource.url,
        featureKey: 'text.word_count',
        value: String(words.length),
        valueType: FeatureType.NUMBER,
        generatedAt: now,
        ttl,
        expiresAt: now + ttl,
        extractorTool: 'built-in',
        metadata: {}
      },
      {
        id: uuidv4(),
        resourceUrl: resource.url,
        featureKey: 'text.line_count',
        value: String(lines.length),
        valueType: FeatureType.NUMBER,
        generatedAt: now,
        ttl,
        expiresAt: now + ttl,
        extractorTool: 'built-in',
        metadata: {}
      },
      {
        id: uuidv4(),
        resourceUrl: resource.url,
        featureKey: 'text.char_count',
        value: String(text.length),
        valueType: FeatureType.NUMBER,
        generatedAt: now,
        ttl,
        expiresAt: now + ttl,
        extractorTool: 'built-in',
        metadata: {}
      }
    );

    logger.info(`Extracted ${features.length} text features from ${resource.url}`);
    return features;
  }

  async *extractFeaturesStream(
    resourceUrl: string,
    options: ExtractOptions = {}
  ): AsyncGenerator<StreamUpdate> {
    const startTime = Date.now();
    
    yield {
      type: 'extraction_started',
      resourceUrl,
      timestamp: Date.now()
    };

    try {
      const features = await this.extractFeatures(resourceUrl, options);
      
      yield {
        type: 'feature_extracted',
        resourceUrl,
        extractor: 'built-in',
        features: features.map(f => ({
          key: f.featureKey,
          value: f.value,
          type: f.valueType
        })),
        timestamp: Date.now()
      };

      yield {
        type: 'extraction_complete',
        resourceUrl,
        timestamp: Date.now(),
        progress: 100
      };
    } catch (error: any) {
      yield {
        type: 'extraction_error',
        resourceUrl,
        error: error.message,
        timestamp: Date.now()
      };
    }
  }

  async close(): Promise<void> {
    // Clean up any resources if needed
  }
}