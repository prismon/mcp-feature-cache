import OpenAI from 'openai';
import { Feature, FeatureType, Resource } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { FeatureStoreError, ErrorCode } from '../types/errors.js';

const logger = createLogger('embedding-extractor');

export interface EmbeddingConfig {
  apiKey?: string;
  model?: string;
  dimensions?: number;
  chunkSize?: number;
  chunkOverlap?: number;
}

export class EmbeddingExtractor {
  private openai: OpenAI | null = null;
  private model: string;
  private dimensions?: number;
  private chunkSize: number;
  private chunkOverlap: number;

  constructor(config: EmbeddingConfig = {}) {
    this.model = config.model || 'text-embedding-3-small';
    this.dimensions = config.dimensions;
    this.chunkSize = config.chunkSize || 2000;
    this.chunkOverlap = config.chunkOverlap || 200;

    const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
      logger.info(`Embedding extractor initialized with model: ${this.model}`);
    } else {
      logger.warn('OpenAI API key not provided. Embedding generation will be disabled.');
    }
  }

  private chunkText(text: string): string[] {
    const chunks: string[] = [];
    let currentPos = 0;

    while (currentPos < text.length) {
      const chunkEnd = Math.min(currentPos + this.chunkSize, text.length);
      let actualEnd = chunkEnd;

      // Try to break at sentence or word boundary
      if (chunkEnd < text.length) {
        const lastPeriod = text.lastIndexOf('.', chunkEnd);
        const lastSpace = text.lastIndexOf(' ', chunkEnd);
        
        if (lastPeriod > currentPos + this.chunkSize * 0.8) {
          actualEnd = lastPeriod + 1;
        } else if (lastSpace > currentPos + this.chunkSize * 0.8) {
          actualEnd = lastSpace;
        }
      }

      chunks.push(text.slice(currentPos, actualEnd).trim());
      currentPos = Math.max(currentPos + 1, actualEnd - this.chunkOverlap);
    }

    return chunks.filter(chunk => chunk.length > 0);
  }

  async generateEmbeddings(text: string): Promise<number[][]> {
    if (!this.openai) {
      throw new FeatureStoreError(
        ErrorCode.EXTRACTOR_ERROR,
        'OpenAI client not initialized. Please provide an API key.'
      );
    }

    const chunks = this.chunkText(text);
    logger.info(`Processing ${chunks.length} text chunks for embeddings`);

    const embeddings: number[][] = [];

    for (let i = 0; i < chunks.length; i++) {
      try {
        const response = await this.openai.embeddings.create({
          model: this.model,
          input: chunks[i],
          dimensions: this.dimensions,
        });

        if (response.data && response.data.length > 0) {
          embeddings.push(response.data[0].embedding);
        }
      } catch (error) {
        logger.error(`Failed to generate embedding for chunk ${i}:`, error);
        throw new FeatureStoreError(
          ErrorCode.EXTRACTOR_ERROR,
          `Failed to generate embedding: ${error}`
        );
      }
    }

    return embeddings;
  }

  async extractFeatures(resource: Resource & { content: Buffer }, ttl: number): Promise<Feature[]> {
    const features: Feature[] = [];

    try {
      // Convert buffer to text
      const text = resource.content.toString('utf-8');
      
      // Skip if text is too short
      if (text.length < 10) {
        logger.info('Text too short for embedding generation');
        return features;
      }

      // Generate embeddings
      const embeddings = await this.generateEmbeddings(text);

      // Store embeddings as features
      embeddings.forEach((embedding, index) => {
        features.push({
          featureKey: `embedding.chunk_${index}`,
          value: JSON.stringify(embedding),
          type: FeatureType.EMBEDDING,
          extractorTool: 'embedding-extractor',
          ttl,
          metadata: {
            model: this.model,
            dimensions: embedding.length,
            chunk_index: index,
            total_chunks: embeddings.length
          }
        });
      });

      // Add summary embedding (average of all chunks)
      if (embeddings.length > 0) {
        const avgEmbedding = new Array(embeddings[0].length).fill(0);
        for (const embedding of embeddings) {
          for (let i = 0; i < embedding.length; i++) {
            avgEmbedding[i] += embedding[i] / embeddings.length;
          }
        }

        features.push({
          featureKey: 'embedding.document',
          value: JSON.stringify(avgEmbedding),
          type: FeatureType.EMBEDDING,
          extractorTool: 'embedding-extractor',
          ttl,
          metadata: {
            model: this.model,
            dimensions: avgEmbedding.length,
            aggregation: 'average',
            total_chunks: embeddings.length
          }
        });
      }

      logger.info(`Generated ${features.length} embedding features`);
    } catch (error) {
      logger.error('Failed to extract embedding features:', error);
      if (error instanceof FeatureStoreError) {
        throw error;
      }
      throw new FeatureStoreError(
        ErrorCode.EXTRACTOR_ERROR,
        `Embedding extraction failed: ${error}`
      );
    }

    return features;
  }

  isAvailable(): boolean {
    return this.openai !== null;
  }
}