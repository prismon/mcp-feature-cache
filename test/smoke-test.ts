#!/usr/bin/env tsx

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile, writeFile } from 'fs/promises';
import { join, basename } from 'path';
import sharp from 'sharp';
import { spawn } from 'child_process';

interface TestResult {
  test: string;
  status: 'passed' | 'failed';
  message?: string;
  features?: any[];
}

class SmokeTest {
  private results: TestResult[] = [];

  async runImageExtractorTest(imagePath?: string) {
    console.log('🧪 Starting Image Extractor Smoke Test\n');
    
    // Create or use test image
    const testImagePath = imagePath || await this.createTestImage();
    console.log(`📸 Using test image: ${testImagePath}\n`);

    // Start the image extractor server
    console.log('🚀 Starting image extractor server...');
    const extractorProcess = spawn('tsx', ['extractors/image/index.ts'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LOG_LEVEL: 'error' }
    });

    // Give server time to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      // Create MCP client
      const client = new Client({
        name: 'smoke-test-client',
        version: '1.0.0'
      }, {
        capabilities: {}
      });

      const transport = new StdioClientTransport({
        command: 'tsx',
        args: ['extractors/image/index.ts'],
        env: { ...process.env, LOG_LEVEL: 'error' }
      });

      await client.connect(transport);
      console.log('✅ Connected to image extractor\n');

      // List available tools
      console.log('📋 Available tools:');
      const toolsResponse = await client.request({
        method: 'tools/list',
        params: {}
      }) as any;
      
      if (toolsResponse.tools) {
        for (const tool of toolsResponse.tools) {
          console.log(`  - ${tool.name}: ${tool.description}`);
        }
      }
      console.log('');

      // Read test image
      const imageBuffer = await readFile(testImagePath);
      const imageBase64 = imageBuffer.toString('base64');

      // Test image feature extraction
      console.log('🔍 Extracting image features...');
      const imageResult = await client.request({
        method: 'tools/call',
        params: {
          name: 'extract_image_features',
          arguments: {
            resourceUrl: testImagePath,
            content: imageBase64,
            contentType: 'image/png'
          }
        }
      }) as any;

      const imageResponse = JSON.parse(imageResult.content[0].text);
      console.log(`✅ Extracted ${imageResponse.features.length} features in ${imageResponse.processingTime}ms\n`);

      // Display extracted features
      console.log('📊 Extracted Features:');
      for (const feature of imageResponse.features) {
        const size = feature.type === 'binary' ? 
          `${Math.round(Buffer.from(feature.value, 'base64').length / 1024)}KB` : 
          typeof feature.value === 'object' ? JSON.stringify(feature.value) : feature.value;
        
        console.log(`  • ${feature.key}: ${feature.type} (${size})`);
        
        if (feature.metadata) {
          console.log(`    Metadata: ${JSON.stringify(feature.metadata)}`);
        }
      }

      // Save sample thumbnail
      const thumbnailFeature = imageResponse.features.find((f: any) => f.key === 'image.thumbnail.medium');
      if (thumbnailFeature) {
        const thumbnailPath = join('test', 'output-thumbnail.png');
        await writeFile(thumbnailPath, Buffer.from(thumbnailFeature.value, 'base64'));
        console.log(`\n💾 Sample thumbnail saved to: ${thumbnailPath}`);
      }

      this.results.push({
        test: 'Image Feature Extraction',
        status: 'passed',
        features: imageResponse.features
      });

      // Test video extraction if we have a video file
      if (imagePath && imagePath.match(/\.(mp4|avi|mov|mkv)$/i)) {
        console.log('\n🎬 Testing video extraction...');
        const videoResult = await client.request({
          method: 'tools/call',
          params: {
            name: 'extract_video_features',
            arguments: {
              resourceUrl: imagePath,
              content: imageBase64,
              contentType: 'video/mp4'
            }
          }
        });

        const videoResponse = JSON.parse(videoResult.content[0].text);
        console.log(`✅ Extracted ${videoResponse.features.length} video features\n`);

        this.results.push({
          test: 'Video Feature Extraction',
          status: 'passed',
          features: videoResponse.features
        });
      }

      await client.close();
      console.log('\n✅ All tests completed successfully!');

    } catch (error: any) {
      console.error('❌ Test failed:', error.message);
      this.results.push({
        test: 'Feature Extraction',
        status: 'failed',
        message: error.message
      });
    } finally {
      extractorProcess.kill();
    }

    // Print summary
    this.printSummary();
  }

  private async createTestImage(): Promise<string> {
    const testDir = 'test';
    await import('fs').then(fs => fs.promises.mkdir(testDir, { recursive: true }));
    
    const imagePath = join(testDir, 'test-image.png');
    
    // Create a colorful test image with gradients
    const width = 800;
    const height = 600;
    
    await sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 }
      }
    })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${width}" height="${height}">
            <defs>
              <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:rgb(255,0,0);stop-opacity:1" />
                <stop offset="50%" style="stop-color:rgb(0,255,0);stop-opacity:1" />
                <stop offset="100%" style="stop-color:rgb(0,0,255);stop-opacity:1" />
              </linearGradient>
            </defs>
            <rect width="${width}" height="${height}" fill="url(#grad1)" />
            <text x="${width/2}" y="${height/2}" font-size="48" fill="white" text-anchor="middle">
              MCP Test Image
            </text>
          </svg>`
        ),
        top: 0,
        left: 0
      }
    ])
    .png()
    .toFile(imagePath);

    return imagePath;
  }

  private printSummary() {
    console.log('\n' + '='.repeat(50));
    console.log('📊 TEST SUMMARY');
    console.log('='.repeat(50));
    
    const passed = this.results.filter(r => r.status === 'passed').length;
    const failed = this.results.filter(r => r.status === 'failed').length;
    
    for (const result of this.results) {
      const icon = result.status === 'passed' ? '✅' : '❌';
      console.log(`${icon} ${result.test}: ${result.status.toUpperCase()}`);
      if (result.message) {
        console.log(`   ${result.message}`);
      }
    }
    
    console.log('\n' + '-'.repeat(50));
    console.log(`Total: ${this.results.length} | Passed: ${passed} | Failed: ${failed}`);
    console.log('='.repeat(50));
  }
}

// Run the smoke test
async function main() {
  const tester = new SmokeTest();
  
  // Check if user provided an image/video path
  const filePath = process.argv[2];
  
  if (filePath) {
    console.log(`Using provided file: ${filePath}`);
  }
  
  await tester.runImageExtractorTest(filePath);
  
  process.exit(0);
}

// Usage instructions
if (process.argv.includes('--help')) {
  console.log(`
MCP Feature Store - Image Extractor Smoke Test

Usage:
  npm run test:smoke                    # Use generated test image
  npm run test:smoke /path/to/image.jpg # Test with specific image
  npm run test:smoke /path/to/video.mp4 # Test with video file

The test will:
1. Start the image extractor MCP server
2. Connect as a client
3. Extract features from the image/video
4. Display the results
5. Save a sample thumbnail
`);
  process.exit(0);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});