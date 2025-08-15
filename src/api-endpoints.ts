import { Request, Response } from 'express';
import { FeatureDatabase } from './db/database.js';
import { FeatureType } from './types/index.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('api-endpoints');

export function setupApiEndpoints(app: any, sharedDb: FeatureDatabase) {
  
  // Get a single feature value
  app.get('/api/features/:resourceUrl/:featureKey', async (req: Request, res: Response) => {
    const { resourceUrl, featureKey } = req.params;
    const { format = 'json' } = req.query;
    const timer = logger.startTimer('get-feature-value');
    
    logger.debug('Feature value request', { resourceUrl, featureKey, format });
    
    try {
      // Decode the URL parameter
      const decodedUrl = decodeURIComponent(resourceUrl);
      
      // Query the database for the specific feature
      const features = await sharedDb.queryFeatures({
        url: decodedUrl,
        featureKeys: [featureKey]
      });
      
      if (features.length === 0) {
        logger.warn('Feature not found', { resourceUrl: decodedUrl, featureKey });
        res.status(404).json({ 
          error: 'Feature not found',
          resourceUrl: decodedUrl,
          featureKey 
        });
        return;
      }
      
      const feature = features[0];
      
      // Handle different response formats
      if (format === 'raw' && feature.valueType === FeatureType.BINARY) {
        // Return raw binary data
        const buffer = Buffer.from(feature.value, 'base64');
        
        // Determine content type
        let contentType = 'application/octet-stream';
        if (featureKey.includes('thumbnail') || featureKey.includes('snapshot')) {
          contentType = 'image/png';
        } else if (featureKey.includes('image')) {
          contentType = 'image/jpeg';
        } else if (featureKey.includes('video')) {
          contentType = 'video/mp4';
        }
        
        res.set({
          'Content-Type': contentType,
          'Content-Length': buffer.length.toString(),
          'Cache-Control': 'public, max-age=86400',
          'X-Feature-Key': featureKey,
          'X-Resource-Url': decodedUrl
        });
        
        timer();
        logger.verbose('Serving raw feature value', { 
          resourceUrl: decodedUrl,
          featureKey,
          bytes: buffer.length
        });
        
        res.send(buffer);
      } else {
        // Return JSON response
        timer();
        logger.verbose('Serving feature value as JSON', { 
          resourceUrl: decodedUrl,
          featureKey
        });
        
        res.json({
          resourceUrl: feature.resourceUrl,
          featureKey: feature.featureKey,
          value: feature.value,
          valueType: feature.valueType,
          metadata: feature.metadata,
          generatedAt: feature.generatedAt,
          expiresAt: feature.expiresAt
        });
      }
    } catch (error: any) {
      timer();
      logger.error('Error serving feature value', error, { resourceUrl, featureKey });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get multiple feature values (batch API)
  app.post('/api/features/batch', async (req: Request, res: Response) => {
    const timer = logger.startTimer('get-feature-batch');
    const { requests } = req.body;
    
    if (!Array.isArray(requests)) {
      res.status(400).json({ error: 'Invalid request format. Expected array of requests.' });
      return;
    }
    
    logger.debug('Batch feature request', { requestCount: requests.length });
    
    try {
      const results = [];
      
      for (const request of requests) {
        const { resourceUrl, featureKey } = request;
        
        if (!resourceUrl || !featureKey) {
          results.push({
            error: 'Missing resourceUrl or featureKey',
            request
          });
          continue;
        }
        
        try {
          const features = await sharedDb.queryFeatures({
            url: resourceUrl,
            featureKeys: [featureKey]
          });
          
          if (features.length === 0) {
            results.push({
              resourceUrl,
              featureKey,
              error: 'Not found'
            });
          } else {
            const feature = features[0];
            results.push({
              resourceUrl: feature.resourceUrl,
              featureKey: feature.featureKey,
              value: feature.value,
              valueType: feature.valueType,
              metadata: feature.metadata,
              generatedAt: feature.generatedAt,
              expiresAt: feature.expiresAt
            });
          }
        } catch (error: any) {
          logger.warn('Error fetching feature in batch', { resourceUrl, featureKey, error: error.message });
          results.push({
            resourceUrl,
            featureKey,
            error: error.message
          });
        }
      }
      
      timer();
      logger.info('Batch feature request completed', { 
        requestCount: requests.length,
        successCount: results.filter((r: any) => !r.error).length
      });
      
      res.json({ results });
    } catch (error: any) {
      timer();
      logger.error('Error processing batch request', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // List all features for a resource
  app.get('/api/features/:resourceUrl', async (req: Request, res: Response) => {
    const { resourceUrl } = req.params;
    const timer = logger.startTimer('list-features');
    
    logger.debug('List features request', { resourceUrl });
    
    try {
      const decodedUrl = decodeURIComponent(resourceUrl);
      const features = await sharedDb.queryFeatures({ url: decodedUrl });
      
      timer();
      logger.info('Listed features', { 
        resourceUrl: decodedUrl,
        featureCount: features.length 
      });
      
      res.json({
        resourceUrl: decodedUrl,
        featureCount: features.length,
        features: features.map(f => ({
          featureKey: f.featureKey,
          valueType: f.valueType,
          metadata: f.metadata,
          generatedAt: f.generatedAt,
          expiresAt: f.expiresAt,
          // For binary features, provide URL to fetch the value
          valueUrl: f.valueType === FeatureType.BINARY 
            ? `/api/features/${encodeURIComponent(decodedUrl)}/${f.featureKey}?format=raw`
            : undefined,
          // For non-binary, include the value directly
          value: f.valueType !== FeatureType.BINARY ? f.value : undefined
        }))
      });
    } catch (error: any) {
      timer();
      logger.error('Error listing features', error, { resourceUrl });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  logger.info('API endpoints configured');
}