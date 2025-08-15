import { readdir, stat } from 'fs/promises';
import { join, dirname, extname, isAbsolute } from 'path';
import { createLogger } from '../utils/logger.js';
import { FeatureDatabase } from '../db/database.js';
import pLimit from 'p-limit';

const logger = createLogger('directory-indexer');

export interface DirectoryIndexOptions {
  includeSubdirectories?: boolean;
  fileExtensions?: string[];
  maxFiles?: number;
  ttl?: number;
  includeEmbeddings?: boolean;
  concurrency?: number;
}

export class DirectoryIndexer {
  private db: FeatureDatabase;
  private orchestrator: any; // Will be passed in to avoid circular dependency
  
  constructor(db: FeatureDatabase, orchestrator?: any) {
    this.db = db;
    this.orchestrator = orchestrator;
  }

  /**
   * Check if we should index a directory based on a file request
   */
  async shouldIndexDirectory(filePath: string): Promise<boolean> {
    try {
      // Get the directory of the requested file
      const directory = dirname(filePath);
      
      logger.debug('Checking if directory should be indexed', { 
        filePath, 
        directory 
      });

      // Check if we've already indexed files from this directory recently
      const existingFeatures = await this.db.queryFeatures({ 
        url: `file://${directory}` 
      });

      if (existingFeatures.length > 0) {
        // Check if any features are still valid (not expired)
        const now = Math.floor(Date.now() / 1000);
        const validFeatures = existingFeatures.filter(f => f.expiresAt > now);
        
        if (validFeatures.length > 0) {
          logger.debug('Directory already indexed with valid features', {
            directory,
            validFeatureCount: validFeatures.length
          });
          return false;
        }
      }

      return true;
    } catch (error) {
      logger.error('Error checking directory index status', error);
      return false;
    }
  }

  /**
   * Index all files in a directory
   */
  async indexDirectory(
    directoryPath: string, 
    options: DirectoryIndexOptions = {}
  ): Promise<{ indexed: string[], skipped: string[], errors: string[] }> {
    const {
      includeSubdirectories = false,
      fileExtensions,
      maxFiles = 100,
      ttl = 86400,
      includeEmbeddings = false,
      concurrency = 3
    } = options;

    const results = {
      indexed: [] as string[],
      skipped: [] as string[],
      errors: [] as string[]
    };

    logger.info('Starting directory indexing', {
      directory: directoryPath,
      options
    });

    try {
      // Get absolute path
      const absPath = isAbsolute(directoryPath) ? directoryPath : join(process.cwd(), directoryPath);
      
      // Get all files in directory
      const files = await this.getFilesInDirectory(
        absPath, 
        includeSubdirectories, 
        fileExtensions,
        maxFiles
      );

      logger.debug('Found files to index', {
        directory: absPath,
        fileCount: files.length
      });

      // Create concurrency limiter
      const limit = pLimit(concurrency);

      // Process files in parallel with concurrency limit
      const indexPromises = files.map(filePath => 
        limit(async () => {
          try {
            logger.trace('Indexing file', { filePath });
            
            // Check if file already has valid features
            const existingFeatures = await this.db.queryFeatures({ 
              url: `file://${filePath}` 
            });
            
            const now = Math.floor(Date.now() / 1000);
            const validFeatures = existingFeatures.filter(f => f.expiresAt > now);
            
            if (validFeatures.length > 0) {
              logger.trace('File already has valid features, skipping', { 
                filePath,
                featureCount: validFeatures.length 
              });
              results.skipped.push(filePath);
              return;
            }

            // Extract features for the file (only if orchestrator is available)
            if (this.orchestrator) {
              await this.orchestrator.extractFeatures(filePath, {
                ttl,
                includeEmbeddings,
                force: false,
                skipDirectoryIndexing: true // Prevent recursive directory indexing
              });
            } else {
              logger.warn('No orchestrator available for indexing', { filePath });
              results.skipped.push(filePath);
              return;
            }

            results.indexed.push(filePath);
            logger.debug('File indexed successfully', { filePath });
          } catch (error: any) {
            logger.error('Failed to index file', error, { filePath });
            results.errors.push(filePath);
          }
        })
      );

      await Promise.all(indexPromises);

      // Store directory index metadata
      await this.storeDirectoryMetadata(absPath, results, ttl);

      logger.info('Directory indexing completed', {
        directory: absPath,
        indexed: results.indexed.length,
        skipped: results.skipped.length,
        errors: results.errors.length
      });

    } catch (error) {
      logger.error('Directory indexing failed', error, { directory: directoryPath });
      throw error;
    }

    return results;
  }

  /**
   * Get all files in a directory (optionally recursive)
   */
  private async getFilesInDirectory(
    dirPath: string, 
    recursive: boolean,
    extensions?: string[],
    maxFiles?: number
  ): Promise<string[]> {
    const files: string[] = [];

    async function scanDir(dir: string) {
      if (maxFiles && files.length >= maxFiles) return;

      try {
        const entries = await readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (maxFiles && files.length >= maxFiles) break;

          const fullPath = join(dir, entry.name);

          if (entry.isDirectory() && recursive) {
            await scanDir(fullPath);
          } else if (entry.isFile()) {
            // Check file extension if filter is provided
            if (extensions && extensions.length > 0) {
              const ext = extname(entry.name).toLowerCase();
              if (!extensions.includes(ext)) continue;
            }

            files.push(fullPath);
          }
        }
      } catch (error) {
        logger.warn('Error scanning directory', { dir, error });
      }
    }

    await scanDir(dirPath);
    return files;
  }

  /**
   * Store metadata about the directory indexing operation
   */
  private async storeDirectoryMetadata(
    directory: string,
    results: { indexed: string[], skipped: string[], errors: string[] },
    ttl: number
  ): Promise<void> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const directoryUrl = `file://${directory}`;
      
      // First, register the directory as a resource
      await this.db.upsertResource({
        url: directoryUrl,
        type: 'directory' as any,
        lastProcessed: now,
        checksum: '', // Directories don't have checksums
        size: results.indexed.length + results.skipped.length,
        mimeType: 'inode/directory'
      });
      
      // Store as a special feature for the directory itself
      await this.db.storeFeatures(directoryUrl, [{
        key: 'directory.index_metadata',
        value: JSON.stringify({
          indexedAt: now,
          fileCount: results.indexed.length + results.skipped.length,
          indexedCount: results.indexed.length,
          skippedCount: results.skipped.length,
          errorCount: results.errors.length,
          files: results.indexed
        }),
        type: 'json' as any,
        ttl,
        extractorTool: 'directory-indexer',
        metadata: {
          directory,
          timestamp: now
        }
      }]);

      logger.debug('Directory metadata stored', { directory });
    } catch (error) {
      logger.error('Failed to store directory metadata', error, { directory });
    }
  }

  /**
   * Get indexed files from a directory
   */
  async getIndexedFiles(directory: string): Promise<string[]> {
    try {
      const features = await this.db.queryFeatures({
        url: `file://${directory}`,
        featureKeys: ['directory.index_metadata']
      });

      if (features.length === 0) {
        return [];
      }

      const metadata = JSON.parse(features[0].value);
      return metadata.files || [];
    } catch (error) {
      logger.error('Failed to get indexed files', error, { directory });
      return [];
    }
  }
}