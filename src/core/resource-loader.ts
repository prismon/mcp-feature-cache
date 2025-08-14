import { readFile, stat } from 'fs/promises';
import { createHash } from 'crypto';
import { lookup } from 'mime-types';
import { URL } from 'url';
import { resolve, isAbsolute } from 'path';
import { Resource, ResourceType } from '../types/index.js';
import { FeatureStoreError, ErrorCode } from '../types/errors.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('resource-loader');

export interface LoadedResource extends Resource {
  content: Buffer;
}

export class ResourceLoader {
  private maxFileSize: number;

  constructor(maxFileSize = 100 * 1024 * 1024) { // Default 100MB
    this.maxFileSize = maxFileSize;
  }

  async load(resourceUrl: string): Promise<LoadedResource> {
    if (this.isUrl(resourceUrl)) {
      return this.loadUrl(resourceUrl);
    } else {
      return this.loadFile(resourceUrl);
    }
  }

  private isUrl(resource: string): boolean {
    try {
      const url = new URL(resource);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private async loadFile(filePath: string): Promise<LoadedResource> {
    try {
      // Resolve to absolute path
      const absolutePath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
      
      // Check file stats
      const stats = await stat(absolutePath);
      
      if (!stats.isFile()) {
        throw new FeatureStoreError(
          ErrorCode.INVALID_URL,
          `Path is not a file: ${filePath}`
        );
      }

      if (stats.size > this.maxFileSize) {
        throw new FeatureStoreError(
          ErrorCode.RESOURCE_NOT_FOUND,
          `File exceeds maximum size limit: ${stats.size} bytes`
        );
      }

      // Read file content
      const content = await readFile(absolutePath);
      
      // Calculate checksum
      const checksum = createHash('sha256').update(content).digest('hex');
      
      // Detect MIME type with special handling for TypeScript
      let mimeType = lookup(absolutePath) || 'application/octet-stream';
      
      // Fix MIME type for TypeScript files
      if (absolutePath.endsWith('.ts') || absolutePath.endsWith('.tsx')) {
        mimeType = 'text/typescript';
      } else if (absolutePath.endsWith('.js') || absolutePath.endsWith('.jsx')) {
        mimeType = 'application/javascript';
      }

      logger.info(`Loaded file: ${absolutePath} (${stats.size} bytes, ${mimeType})`);

      return {
        url: `file://${absolutePath}`,
        type: ResourceType.FILE,
        lastProcessed: Math.floor(Date.now() / 1000),
        checksum,
        size: stats.size,
        mimeType,
        content
      };
    } catch (error: any) {
      if (error instanceof FeatureStoreError) {
        throw error;
      }
      
      throw new FeatureStoreError(
        ErrorCode.RESOURCE_NOT_FOUND,
        `Failed to load file ${filePath}: ${error.message}`
      );
    }
  }

  private async loadUrl(url: string): Promise<LoadedResource> {
    try {
      logger.info(`Fetching URL: ${url}`);
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'MCP-Feature-Store/1.0'
        }
      });

      if (!response.ok) {
        throw new FeatureStoreError(
          ErrorCode.RESOURCE_NOT_FOUND,
          `HTTP ${response.status}: ${response.statusText}`
        );
      }

      // Check content length
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > this.maxFileSize) {
        throw new FeatureStoreError(
          ErrorCode.RESOURCE_NOT_FOUND,
          `Content exceeds maximum size limit: ${contentLength} bytes`
        );
      }

      // Get content
      const buffer = await response.arrayBuffer();
      const content = Buffer.from(buffer);

      if (content.length > this.maxFileSize) {
        throw new FeatureStoreError(
          ErrorCode.RESOURCE_NOT_FOUND,
          `Content exceeds maximum size limit: ${content.length} bytes`
        );
      }

      // Calculate checksum
      const checksum = createHash('sha256').update(content).digest('hex');
      
      // Get MIME type
      const mimeType = response.headers.get('content-type') || 'application/octet-stream';

      logger.info(`Loaded URL: ${url} (${content.length} bytes, ${mimeType})`);

      return {
        url,
        type: ResourceType.URL,
        lastProcessed: Math.floor(Date.now() / 1000),
        checksum,
        size: content.length,
        mimeType: mimeType.split(';')[0], // Remove charset info
        content
      };
    } catch (error: any) {
      if (error instanceof FeatureStoreError) {
        throw error;
      }
      
      throw new FeatureStoreError(
        ErrorCode.RESOURCE_NOT_FOUND,
        `Failed to fetch URL ${url}: ${error.message}`
      );
    }
  }
}