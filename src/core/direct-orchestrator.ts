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
import { DirectoryIndexer } from './directory-indexer.js';
import { v4 as uuidv4 } from 'uuid';
import { dirname, isAbsolute } from 'path';
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
  skipDirectoryIndexing?: boolean; // Flag to prevent recursive directory indexing
  mode?: 'minimal' | 'standard' | 'maximal';
  updateMissing?: boolean;
}

export class DirectFeatureOrchestrator {
  private db: FeatureDatabase;
  private resourceLoader: ResourceLoader;
  private embeddingExtractor: EmbeddingExtractor;
  private directoryIndexer: DirectoryIndexer;
  private concurrencyLimit = pLimit(5);
  private tempDir: string;

  constructor(db: FeatureDatabase) {
    this.db = db;
    this.resourceLoader = new ResourceLoader();
    this.embeddingExtractor = new EmbeddingExtractor();
    this.directoryIndexer = new DirectoryIndexer(db, this); // Pass this orchestrator
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
      // Check if this is a file and if we should index its directory
      // Skip directory indexing if the flag is set (to prevent recursion)
      if (!options.skipDirectoryIndexing && (resourceUrl.startsWith('/') || resourceUrl.startsWith('file://'))) {
        const filePath = resourceUrl.replace('file://', '');
        const shouldIndex = await this.directoryIndexer.shouldIndexDirectory(filePath);
        
        if (shouldIndex) {
          logger.info('Indexing directory for file', { 
            file: filePath,
            directory: dirname(filePath)
          });
          
          // Index the directory in the background
          this.directoryIndexer.indexDirectory(dirname(filePath), {
            includeSubdirectories: false,
            ttl: options.ttl || 86400,
            includeEmbeddings: options.includeEmbeddings,
            concurrency: 3,
            maxFiles: 50 // Limit to prevent overwhelming the system
          }).catch(error => {
            logger.error('Background directory indexing failed', error, {
              directory: dirname(filePath)
            });
          });
        }
      }
      
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
      
      // Check if we should skip extraction or update missing features
      let existingFeatures: Feature[] = [];
      if (!options.force) {
        logger.trace('Checking for cached features', { url: resource.url });
        const existingResource = await this.db.getResource(resource.url);
        
        if (existingResource) {
          logger.verbose('Found existing resource', {
            url: resource.url,
            checksum: existingResource.checksum,
            lastProcessed: existingResource.lastProcessed
          });
          
          if (existingResource.checksum === resource.checksum) {
            existingFeatures = await this.db.queryFeatures({ url: resource.url });
            
            // If updateMissing is false and we have features, return cached
            if (!options.updateMissing && existingFeatures.length > 0) {
              timer();
              logger.info(`Using cached features for ${resource.url}`, {
                featureCount: existingFeatures.length,
                cached: true
              });
              return existingFeatures;
            }
            
            // If updateMissing is true, we'll continue to extract missing features
            if (options.updateMissing && existingFeatures.length > 0) {
              logger.info('Will update missing features only', {
                existingCount: existingFeatures.length
              });
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

      // Save/update resource - use normalized URL from resource loader
      logger.trace('Upserting resource in database', { url: resource.url });
      const dbTimer = logger.startTimer('db-upsert-resource');
      await this.db.upsertResource({
        url: resource.url,  // Use normalized URL
        type: resource.type,
        lastProcessed: Math.floor(Date.now() / 1000),
        checksum: resource.checksum,
        size: resource.size,
        mimeType: resource.mimeType
      });
      dbTimer();
      logger.verbose('Resource saved to database', { url: resource.url });

      // Extract features based on MIME type
      let features: Feature[] = [];
      const mimeType = resource.mimeType || 'unknown';
      
      // Build set of existing feature keys for checking
      const existingFeatureKeys = new Set(existingFeatures.map(f => f.featureKey));
      
      logger.debug('Selecting extractor based on MIME type', { 
        mimeType,
        url: resourceUrl,
        mode: options.mode || 'standard',
        updateMissing: options.updateMissing !== false,
        existingFeatures: existingFeatureKeys.size
      });
      
      if (resource.mimeType === 'inode/directory' || resource.type === ResourceType.DIRECTORY) {
        logger.info('Processing directory - will recursively extract features from all files', { 
          directory: resource.url 
        });
        
        // First extract directory metadata
        const dirTimer = logger.startTimer('extract-directory-features');
        features = await this.extractDirectoryFeatures(
          resource, 
          options.ttl || 86400,
          options.mode || 'standard',
          existingFeatureKeys,
          options.updateMissing !== false
        );
        dirTimer();
        
        // Then recursively process all files in the directory
        const dirPath = resource.url.replace('file://', '');
        const processedFiles = await this.recursivelyExtractFromDirectory(dirPath, {
          ...options,
          skipDirectoryIndexing: true // Prevent infinite recursion
        });
        
        logger.info('Directory extraction completed', {
          directory: dirPath,
          filesProcessed: processedFiles.length,
          totalFeatures: features.length
        });
        
        // Add the summary feature to the directory features
        features.push({
          id: uuidv4(),
          resourceUrl: resource.url,
          featureKey: 'extraction.summary',
          value: JSON.stringify({
            type: 'directory',
            path: dirPath,
            filesProcessed: processedFiles.length,
            directoryFeatures: features.length,
            message: `Successfully extracted features from ${processedFiles.length} files in directory`
          }),
          valueType: FeatureType.JSON,
          generatedAt: Math.floor(Date.now() / 1000),
          ttl: options.ttl || 86400,
          expiresAt: Math.floor(Date.now() / 1000) + (options.ttl || 86400),
          extractorTool: 'directory-extractor',
          metadata: { filesProcessed: processedFiles }
        });
        
        // Don't return early - let the features be stored below
      } else if (resource.mimeType?.startsWith('image/')) {
        logger.trace('Using image extractor', { mimeType });
        const imageTimer = logger.startTimer('extract-image-features');
        features = await this.extractImageFeatures(
          resource, 
          options.ttl || 86400,
          options.mode || 'standard',
          existingFeatureKeys,
          options.updateMissing !== false
        );
        imageTimer();
      } else if (resource.mimeType?.startsWith('video/')) {
        logger.trace('Using video extractor', { mimeType });
        const videoTimer = logger.startTimer('extract-video-features');
        features = await this.extractVideoFeatures(
          resource, 
          options.ttl || 86400,
          options.mode || 'standard',
          existingFeatureKeys,
          options.updateMissing !== false
        );
        videoTimer();
      } else if (resource.mimeType?.startsWith('text/') || 
                 resource.mimeType === 'application/json' ||
                 resource.mimeType === 'application/javascript' ||
                 resource.mimeType === 'text/typescript') {
        logger.trace('Using text extractor', { mimeType });
        const textTimer = logger.startTimer('extract-text-features');
        features = await this.extractTextFeatures(
          resource, 
          options.ttl || 86400,
          options.mode || 'standard',
          existingFeatureKeys,
          options.updateMissing !== false
        );
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
        logger.debug('Storing features', {
          url: resource.url,
          featureCount: features.length,
          featureKeys: features.map(f => f.featureKey)
        });
        
        const featuresToStore = features.map(f => ({
          key: f.featureKey,
          value: f.value,
          type: f.valueType,
          ttl: f.ttl,
          extractorTool: f.extractorTool || 'built-in',
          metadata: f.metadata
        }));

        await this.db.storeFeatures(resource.url, featuresToStore);
        logger.trace('Features stored successfully');
      } else {
        logger.debug('No features to store', { url: resource.url });
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

  private async extractImageFeatures(
    resource: Resource & { content: Buffer }, 
    ttl: number,
    mode: 'minimal' | 'standard' | 'maximal' = 'standard',
    existingFeatureKeys: Set<string> = new Set(),
    updateMissing: boolean = true
  ): Promise<Feature[]> {
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
      const encodedResourceUrl = encodeURIComponent(resource.url);
      const thumbnailFeatures = [];
      
      // Only generate thumbnails if they should be extracted
      if (this.shouldExtractFeature('image.thumbnail.small', mode, existingFeatureKeys, updateMissing)) {
        thumbnailFeatures.push({
          key: 'image.thumbnail_small',
          buffer: thumbnailSmall,
          dimensions: '150x150',
          url: `${serverUrl}/api/features/${encodedResourceUrl}/image.thumbnail_small?format=raw`
        });
      }
      
      if (this.shouldExtractFeature('image.thumbnail.medium', mode, existingFeatureKeys, updateMissing)) {
        thumbnailFeatures.push({
          key: 'image.thumbnail_medium',
          buffer: thumbnailMedium,
          dimensions: '400x400',
          url: `${serverUrl}/api/features/${encodedResourceUrl}/image.thumbnail_medium?format=raw`
        });
      }
      
      if (this.shouldExtractFeature('image.thumbnail.large', mode, existingFeatureKeys, updateMissing) && mode === 'maximal') {
        thumbnailFeatures.push({
          key: 'image.thumbnail_large',
          buffer: thumbnailLarge,
          dimensions: '1920x1080',
          url: `${serverUrl}/api/features/${encodedResourceUrl}/image.thumbnail_large?format=raw`
        });
      }
      
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
      for (const thumb of thumbnailFeatures) {
        features.push({
          id: uuidv4(),
          resourceUrl: resource.url,
          featureKey: thumb.key.replace('_', '.'),  // Convert image_thumbnail_small to image.thumbnail.small
          value: thumb.url,
          valueType: FeatureType.TEXT,
          generatedAt: now,
          ttl,
          expiresAt: now + ttl,
          extractorTool: 'built-in',
          metadata: { 
            dimensions: thumb.dimensions, 
            format: 'png',
            mediaType: 'url',
            resourceId
          }
        });
      }
      
      if (this.shouldExtractFeature('image.dimensions', mode, existingFeatureKeys, updateMissing)) {
        features.push(
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
          });
      }
      
      if (this.shouldExtractFeature('image.format', mode, existingFeatureKeys, updateMissing)) {
        features.push({
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
        });
      }
      
      if (this.shouldExtractFeature('image.dominant_colors', mode, existingFeatureKeys, updateMissing) && mode === 'maximal') {
        features.push({
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
        });
      }

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

  private async extractVideoFeatures(
    resource: Resource & { content: Buffer }, 
    ttl: number,
    mode: 'minimal' | 'standard' | 'maximal' = 'standard',
    existingFeatureKeys: Set<string> = new Set(),
    updateMissing: boolean = true
  ): Promise<Feature[]> {
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

      // Extract snapshots based on mode
      const percentagesToExtract: number[] = [];
      if (mode === 'minimal') {
        // No video snapshots in minimal mode
      } else if (mode === 'standard') {
        // Only 50% snapshot in standard mode
        if (this.shouldExtractFeature('video.snapshot_50', mode, existingFeatureKeys, updateMissing)) {
          percentagesToExtract.push(50);
        }
      } else if (mode === 'maximal') {
        // All snapshots in maximal mode
        for (let percentage = 0; percentage <= 90; percentage += 10) {
          if (this.shouldExtractFeature(`video.snapshot_${percentage}`, mode, existingFeatureKeys, updateMissing)) {
            percentagesToExtract.push(percentage);
          }
        }
      }
      
      for (const percentage of percentagesToExtract) {
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
      
      // Add video metadata features
      if (this.shouldExtractFeature('video.dimensions', mode, existingFeatureKeys, updateMissing)) {
        features.push({
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
        });
      }
      
      if (this.shouldExtractFeature('video.duration', mode, existingFeatureKeys, updateMissing)) {
        features.push({
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
        });
      }

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

  private async extractTextFeatures(
    resource: Resource & { content: Buffer }, 
    ttl: number,
    mode: 'minimal' | 'standard' | 'maximal' = 'standard',
    existingFeatureKeys: Set<string> = new Set(),
    updateMissing: boolean = true
  ): Promise<Feature[]> {
    const features: Feature[] = [];
    const text = resource.content.toString('utf-8');
    const lines = text.split('\n');
    const words = text.split(/\s+/).filter(w => w.length > 0);
    
    const now = Math.floor(Date.now() / 1000);

    // Only add features that should be extracted based on mode and existing features
    if (this.shouldExtractFeature('text.content', mode, existingFeatureKeys, updateMissing)) {
      features.push({
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
      });
    }
    
    if (this.shouldExtractFeature('text.word_count', mode, existingFeatureKeys, updateMissing)) {
      features.push({
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
      });
    }
    
    if (this.shouldExtractFeature('text.line_count', mode, existingFeatureKeys, updateMissing)) {
      features.push({
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
      });
    }
    
    if (this.shouldExtractFeature('text.char_count', mode, existingFeatureKeys, updateMissing)) {
      features.push({
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
      });
    }

    logger.info(`Extracted ${features.length} text features from ${resource.url}`, {
      mode,
      updateMissing,
      skipped: 4 - features.length
    });
    return features;
  }

  private async extractDirectoryFeatures(
    resource: Resource, 
    ttl: number,
    mode: 'minimal' | 'standard' | 'maximal' = 'standard',
    existingFeatureKeys: Set<string> = new Set(),
    updateMissing: boolean = true
  ): Promise<Feature[]> {
    const features: Feature[] = [];
    const now = Math.floor(Date.now() / 1000);
    
    try {
      // Extract directory path from URL
      const dirPath = resource.url.replace('file://', '');
      
      // Import fs modules
      const { readdir, stat } = await import('fs/promises');
      const { join, basename } = await import('path');
      
      // Get directory contents
      const entries = await readdir(dirPath, { withFileTypes: true });
      
      // Separate files and subdirectories
      const files = entries.filter(e => e.isFile());
      const subdirs = entries.filter(e => e.isDirectory());
      
      // Calculate total size
      let totalSize = 0;
      const fileSizes: { name: string; size: number }[] = [];
      
      for (const file of files) {
        try {
          const filePath = join(dirPath, file.name);
          const stats = await stat(filePath);
          totalSize += stats.size;
          fileSizes.push({ name: file.name, size: stats.size });
        } catch (error) {
          logger.warn(`Failed to stat file: ${file.name}`, error);
        }
      }
      
      // Sort files by size (largest first)
      fileSizes.sort((a, b) => b.size - a.size);
      
      // Create directory metadata
      const dirMetadata = {
        name: basename(dirPath),
        path: dirPath,
        fileCount: files.length,
        subdirectoryCount: subdirs.length,
        totalSize,
        averageFileSize: files.length > 0 ? Math.round(totalSize / files.length) : 0,
        largestFiles: fileSizes.slice(0, 10).map(f => ({
          name: f.name,
          size: f.size,
          sizeFormatted: this.formatFileSize(f.size)
        })),
        fileExtensions: this.getFileExtensions(files.map(f => f.name)),
        files: files.map(f => f.name),
        subdirectories: subdirs.map(d => d.name)
      };
      
      // Add features based on mode and existing features
      if (this.shouldExtractFeature('directory.metadata', mode, existingFeatureKeys, updateMissing)) {
        features.push({
          id: uuidv4(),
          resourceUrl: resource.url,
          featureKey: 'directory.metadata',
          value: JSON.stringify(dirMetadata),
          valueType: FeatureType.JSON,
          generatedAt: now,
          ttl,
          expiresAt: now + ttl,
          extractorTool: 'directory-extractor',
          metadata: { 
            fileCount: files.length,
            subdirectoryCount: subdirs.length
          }
        });
      }
      
      if (this.shouldExtractFeature('directory.file_count', mode, existingFeatureKeys, updateMissing)) {
        features.push({
          id: uuidv4(),
          resourceUrl: resource.url,
          featureKey: 'directory.file_count',
          value: String(files.length),
          valueType: FeatureType.NUMBER,
          generatedAt: now,
          ttl,
          expiresAt: now + ttl,
          extractorTool: 'directory-extractor',
          metadata: {}
        });
      }
      
      if (this.shouldExtractFeature('directory.total_size', mode, existingFeatureKeys, updateMissing)) {
        features.push({
          id: uuidv4(),
          resourceUrl: resource.url,
          featureKey: 'directory.total_size',
          value: String(totalSize),
          valueType: FeatureType.NUMBER,
          generatedAt: now,
          ttl,
          expiresAt: now + ttl,
          extractorTool: 'directory-extractor',
          metadata: { formatted: this.formatFileSize(totalSize) }
        });
      }
      
      if (this.shouldExtractFeature('directory.subdirectory_count', mode, existingFeatureKeys, updateMissing)) {
        features.push({
          id: uuidv4(),
          resourceUrl: resource.url,
          featureKey: 'directory.subdirectory_count',
          value: String(subdirs.length),
          valueType: FeatureType.NUMBER,
          generatedAt: now,
          ttl,
          expiresAt: now + ttl,
          extractorTool: 'directory-extractor',
          metadata: {}
        });
      }
      
      logger.info('Extracted directory features', {
        directory: dirPath,
        featureCount: features.length,
        fileCount: files.length,
        totalSize
      });
      
    } catch (error) {
      logger.error('Failed to extract directory features', error, {
        url: resource.url
      });
    }
    
    return features;
  }
  
  private formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }
  
  private getFileExtensions(fileNames: string[]): Record<string, number> {
    const extensions: Record<string, number> = {};
    
    for (const fileName of fileNames) {
      const dotIndex = fileName.lastIndexOf('.');
      const ext = dotIndex > 0 ? fileName.slice(dotIndex).toLowerCase() : 'no-extension';
      extensions[ext] = (extensions[ext] || 0) + 1;
    }
    
    return extensions;
  }

  private shouldExtractFeature(
    featureKey: string, 
    mode: 'minimal' | 'standard' | 'maximal' = 'standard',
    existingFeatureKeys: Set<string>,
    updateMissing: boolean = true
  ): boolean {
    // If feature already exists and updateMissing is true, skip it
    if (updateMissing && existingFeatureKeys.has(featureKey)) {
      return false;
    }
    
    // Define feature sets for each mode
    const minimalFeatures = new Set([
      'text.content',
      'text.word_count',
      'text.line_count',
      'text.char_count',
      'directory.metadata',
      'directory.file_count',
      'directory.total_size',
      'directory.subdirectory_count'
    ]);
    
    const standardFeatures = new Set([
      ...minimalFeatures,
      'image.thumbnail.small',
      'image.thumbnail.medium',
      'image.dimensions',
      'image.format',
      'video.dimensions',
      'video.duration',
      'video.snapshot_50',
      'directory.subdirectory_count'
    ]);
    
    // Maximal includes everything
    if (mode === 'maximal') {
      return true;
    }
    
    // Check if feature is in the appropriate set
    if (mode === 'minimal') {
      return minimalFeatures.has(featureKey);
    }
    
    // Standard mode
    return standardFeatures.has(featureKey);
  }

  private async recursivelyExtractFromDirectory(
    dirPath: string, 
    options: ExtractOptions
  ): Promise<string[]> {
    const processedFiles: string[] = [];
    
    try {
      const { readdir, stat } = await import('fs/promises');
      const { join } = await import('path');
      
      const walkDirectory = async (currentPath: string): Promise<void> => {
        try {
          const entries = await readdir(currentPath, { withFileTypes: true });
          
          for (const entry of entries) {
            const fullPath = join(currentPath, entry.name);
            
            // Skip hidden files and common ignore patterns
            if (entry.name.startsWith('.') || 
                entry.name === 'node_modules' || 
                entry.name === '__pycache__' ||
                entry.name === 'dist' ||
                entry.name === 'build') {
              logger.trace('Skipping ignored path', { path: fullPath });
              continue;
            }
            
            if (entry.isDirectory()) {
              // Extract features for the subdirectory itself
              try {
                logger.debug('Extracting features for subdirectory', { path: fullPath });
                const dirUrl = `file://${fullPath}`;
                await this.extractFeatures(dirUrl, {
                  ...options,
                  skipDirectoryIndexing: true // Prevent infinite recursion
                });
                processedFiles.push(fullPath);
              } catch (error) {
                logger.error('Failed to extract directory features', error, { path: fullPath });
              }
              
              // Then recursively process its contents
              await walkDirectory(fullPath);
            } else if (entry.isFile()) {
              try {
                // Check file size before processing
                const stats = await stat(fullPath);
                if (stats.size > 100 * 1024 * 1024) { // Skip files > 100MB
                  logger.warn('Skipping large file', { 
                    path: fullPath, 
                    size: stats.size 
                  });
                  continue;
                }
                
                // Extract features for the file
                logger.debug('Extracting features for file', { path: fullPath });
                const fileUrl = `file://${fullPath}`;
                await this.extractFeatures(fileUrl, options);
                processedFiles.push(fullPath);
                
              } catch (error) {
                logger.error('Failed to process file', error, { path: fullPath });
              }
            }
          }
        } catch (error) {
          logger.error('Failed to read directory', error, { path: currentPath });
        }
      }
      
      // Start the recursive walk
      await walkDirectory(dirPath);
      
    } catch (error) {
      logger.error('Failed to recursively extract from directory', error, {
        directory: dirPath
      });
    }
    
    return processedFiles;
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