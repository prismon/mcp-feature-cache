#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import sharp from 'sharp';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { FeatureType } from '../../src/types/index.js';
import { createLogger } from '../../src/utils/logger.js';

const execAsync = promisify(exec);
const logger = createLogger('image-extractor');

interface ImageDimensions {
  width: number;
  height: number;
}

interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
}

class ImageExtractorServer {
  private server: Server;
  private tempDir: string;

  constructor() {
    this.server = new Server(
      {
        name: 'mcp-image-extractor',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.tempDir = join(tmpdir(), 'mcp-image-extractor');
    this.setupHandlers();
    this.initTempDir();
  }

  private async initTempDir() {
    try {
      await mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      logger.error('Failed to create temp directory:', error);
    }
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'extract_image_features',
          description: 'Extract features from images including thumbnails',
          inputSchema: {
            type: 'object',
            properties: {
              resourceUrl: { type: 'string', description: 'Resource URL or file path' },
              content: { type: 'string', description: 'Base64 encoded image content' },
              contentType: { type: 'string', description: 'MIME type of the content' }
            },
            required: ['resourceUrl', 'content', 'contentType']
          }
        },
        {
          name: 'extract_video_features',
          description: 'Extract features from videos including timeline snapshots',
          inputSchema: {
            type: 'object',
            properties: {
              resourceUrl: { type: 'string', description: 'Resource URL or file path' },
              content: { type: 'string', description: 'Base64 encoded video content' },
              contentType: { type: 'string', description: 'MIME type of the content' }
            },
            required: ['resourceUrl', 'content', 'contentType']
          }
        }
      ]
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'extract_image_features':
            return await this.extractImageFeatures(args);
          case 'extract_video_features':
            return await this.extractVideoFeatures(args);
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error: any) {
        logger.error(`Tool execution error: ${name}`, error);
        
        if (error instanceof McpError) {
          throw error;
        }
        
        throw new McpError(
          ErrorCode.InternalError,
          error.message || 'Tool execution failed'
        );
      }
    });
  }

  private async extractImageFeatures(args: any) {
    const { resourceUrl, content, contentType } = args;
    const startTime = Date.now();

    // Decode base64 content
    const buffer = Buffer.from(content, 'base64');

    try {
      // Get image metadata
      const metadata = await sharp(buffer).metadata();
      
      const dimensions: ImageDimensions = {
        width: metadata.width || 0,
        height: metadata.height || 0
      };

      // Generate thumbnails
      const thumbnailSmall = await this.generateThumbnail(buffer, 150, 150);
      const thumbnailMedium = await this.generateThumbnail(buffer, 400, 400);
      const thumbnailLarge = await this.generateThumbnail(buffer, 1920, 1080);

      // Get dominant colors
      const stats = await sharp(buffer).stats();
      const dominantColors = {
        channels: stats.channels.map(ch => ({
          mean: Math.round(ch.mean),
          min: ch.min,
          max: ch.max
        }))
      };

      const features = [
        {
          key: 'image.thumbnail.small',
          value: thumbnailSmall,
          type: FeatureType.BINARY,
          ttl: 86400, // 24 hours
          metadata: { dimensions: '150x150', format: 'png' }
        },
        {
          key: 'image.thumbnail.medium',
          value: thumbnailMedium,
          type: FeatureType.BINARY,
          ttl: 86400,
          metadata: { dimensions: '400x400', format: 'png' }
        },
        {
          key: 'image.thumbnail.timeline',
          value: thumbnailLarge,
          type: FeatureType.BINARY,
          ttl: 86400,
          metadata: { dimensions: '1920x1080', format: 'png' }
        },
        {
          key: 'image.dimensions',
          value: dimensions,
          type: FeatureType.JSON,
          ttl: 86400
        },
        {
          key: 'image.format',
          value: metadata.format || 'unknown',
          type: FeatureType.TEXT,
          ttl: 86400
        },
        {
          key: 'image.dominant_colors',
          value: dominantColors,
          type: FeatureType.JSON,
          ttl: 86400
        },
        {
          key: 'image.size',
          value: buffer.length,
          type: FeatureType.NUMBER,
          ttl: 86400
        }
      ];

      // Add EXIF data if available
      if (metadata.exif) {
        features.push({
          key: 'image.exif',
          value: metadata.exif,
          type: FeatureType.BINARY,
          ttl: 86400
        });
      }

      const processingTime = Date.now() - startTime;
      logger.info(`Extracted ${features.length} image features in ${processingTime}ms`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              features,
              extractorVersion: '1.0.0',
              processingTime
            })
          }
        ]
      };
    } catch (error: any) {
      logger.error('Image extraction failed:', error);
      throw new McpError(ErrorCode.InternalError, `Image extraction failed: ${error.message}`);
    }
  }

  private async extractVideoFeatures(args: any) {
    const { resourceUrl, content, contentType } = args;
    const startTime = Date.now();

    // Save video to temp file (ffmpeg needs file access)
    const tempVideoPath = join(this.tempDir, `${uuidv4()}.video`);
    const buffer = Buffer.from(content, 'base64');
    
    try {
      await writeFile(tempVideoPath, buffer);

      // Get video info
      const videoInfo = await this.getVideoInfo(tempVideoPath);

      // Generate snapshots at 10% intervals (0%, 10%, 20%, ..., 90%)
      const snapshots: string[] = [];
      for (let percent = 0; percent <= 90; percent += 10) {
        const timestamp = (videoInfo.duration * percent) / 100;
        const snapshot = await this.extractVideoFrame(tempVideoPath, timestamp);
        snapshots.push(snapshot);
      }

      // Generate main thumbnail from middle frame
      const middleTimestamp = videoInfo.duration / 2;
      const mainThumbnail = await this.extractVideoFrame(tempVideoPath, middleTimestamp);

      const features = [
        {
          key: 'video.thumbnail',
          value: mainThumbnail,
          type: FeatureType.BINARY,
          ttl: 86400,
          metadata: { timestamp: middleTimestamp, format: 'png' }
        },
        {
          key: 'video.timeline_snapshots',
          value: snapshots,
          type: FeatureType.JSON,
          ttl: 86400,
          metadata: { 
            count: snapshots.length,
            intervals: '10%',
            format: 'png'
          }
        },
        {
          key: 'video.dimensions',
          value: { width: videoInfo.width, height: videoInfo.height },
          type: FeatureType.JSON,
          ttl: 86400
        },
        {
          key: 'video.duration',
          value: videoInfo.duration,
          type: FeatureType.NUMBER,
          ttl: 86400,
          metadata: { unit: 'seconds' }
        },
        {
          key: 'video.fps',
          value: videoInfo.fps,
          type: FeatureType.NUMBER,
          ttl: 86400
        },
        {
          key: 'video.size',
          value: buffer.length,
          type: FeatureType.NUMBER,
          ttl: 86400
        }
      ];

      const processingTime = Date.now() - startTime;
      logger.info(`Extracted ${features.length} video features in ${processingTime}ms`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              features,
              extractorVersion: '1.0.0',
              processingTime
            })
          }
        ]
      };
    } catch (error: any) {
      logger.error('Video extraction failed:', error);
      throw new McpError(ErrorCode.InternalError, `Video extraction failed: ${error.message}`);
    } finally {
      // Clean up temp file
      try {
        await unlink(tempVideoPath);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }

  private async generateThumbnail(
    buffer: Buffer,
    maxWidth: number,
    maxHeight: number
  ): Promise<string> {
    const thumbnail = await sharp(buffer)
      .resize(maxWidth, maxHeight, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .png()
      .toBuffer();

    return thumbnail.toString('base64');
  }

  private async getVideoInfo(videoPath: string): Promise<VideoInfo> {
    const { stdout } = await execAsync(
      `ffprobe -v quiet -print_format json -show_format -show_streams "${videoPath}"`
    );

    const info = JSON.parse(stdout);
    const videoStream = info.streams.find((s: any) => s.codec_type === 'video');

    if (!videoStream) {
      throw new Error('No video stream found');
    }

    // Parse frame rate (can be in format like "30/1" or "29.97")
    let fps = 30; // default
    if (videoStream.r_frame_rate) {
      const parts = videoStream.r_frame_rate.split('/');
      fps = parts.length === 2 ? parseInt(parts[0]) / parseInt(parts[1]) : parseFloat(parts[0]);
    }

    return {
      duration: parseFloat(info.format.duration || '0'),
      width: videoStream.width || 0,
      height: videoStream.height || 0,
      fps
    };
  }

  private async extractVideoFrame(videoPath: string, timestamp: number): Promise<string> {
    const outputPath = join(this.tempDir, `${uuidv4()}.png`);

    try {
      // Extract frame at specific timestamp
      await execAsync(
        `ffmpeg -ss ${timestamp} -i "${videoPath}" -vframes 1 -vf "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease" -f image2 "${outputPath}" -y`
      );

      // Read the generated image
      const imageBuffer = await sharp(outputPath)
        .png()
        .toBuffer();

      return imageBuffer.toString('base64');
    } finally {
      // Clean up temp file
      try {
        await unlink(outputPath);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('Image/Video Extractor MCP server started');
  }
}

// Check if ffmpeg is available
async function checkFfmpeg(): Promise<boolean> {
  try {
    await execAsync('ffmpeg -version');
    return true;
  } catch {
    return false;
  }
}

// Start the server
const server = new ImageExtractorServer();

// Check dependencies before starting
checkFfmpeg().then(hasFfmpeg => {
  if (!hasFfmpeg) {
    logger.warn('ffmpeg not found. Video extraction features will not work.');
    logger.warn('Install ffmpeg: sudo apt-get install ffmpeg (Ubuntu) or brew install ffmpeg (Mac)');
  }
  
  server.start().catch((error) => {
    logger.error('Failed to start server:', error);
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});