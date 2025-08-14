#!/usr/bin/env tsx

import sharp from 'sharp';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

async function testImageExtractor() {
  console.log('🧪 Direct Image Extractor Test\n');

  // Ensure test directory exists
  await mkdir('test/output', { recursive: true });

  // Create or use test image
  let testImagePath = 'test/test-image.png';
  
  if (!existsSync(testImagePath)) {
    console.log('Creating test image...');
    await createTestImage(testImagePath);
  }

  console.log(`📸 Using test image: ${testImagePath}\n`);

  // Read the image
  const imageBuffer = await readFile(testImagePath);
  console.log(`Image size: ${(imageBuffer.length / 1024).toFixed(2)} KB\n`);

  // Test image processing with sharp directly
  console.log('🔍 Testing image processing capabilities:\n');

  try {
    // 1. Get metadata
    const metadata = await sharp(imageBuffer).metadata();
    console.log('✅ Image metadata:');
    console.log(`   - Format: ${metadata.format}`);
    console.log(`   - Dimensions: ${metadata.width}x${metadata.height}`);
    console.log(`   - Channels: ${metadata.channels}`);
    console.log(`   - Density: ${metadata.density} DPI\n`);

    // 2. Generate thumbnails
    console.log('📐 Generating thumbnails:');
    
    const thumbnailSmall = await sharp(imageBuffer)
      .resize(150, 150, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    await writeFile('test/output/thumbnail-small.png', thumbnailSmall);
    console.log(`   ✅ Small (150x150): ${(thumbnailSmall.length / 1024).toFixed(2)} KB`);

    const thumbnailMedium = await sharp(imageBuffer)
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    await writeFile('test/output/thumbnail-medium.png', thumbnailMedium);
    console.log(`   ✅ Medium (400x400): ${(thumbnailMedium.length / 1024).toFixed(2)} KB`);

    const thumbnailLarge = await sharp(imageBuffer)
      .resize(1920, 1080, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    await writeFile('test/output/thumbnail-large.png', thumbnailLarge);
    console.log(`   ✅ Large (1920x1080): ${(thumbnailLarge.length / 1024).toFixed(2)} KB\n`);

    // 3. Get color statistics
    const stats = await sharp(imageBuffer).stats();
    console.log('🎨 Color analysis:');
    stats.channels.forEach((channel, i) => {
      const channelName = ['Red', 'Green', 'Blue', 'Alpha'][i] || `Channel ${i}`;
      console.log(`   ${channelName}: mean=${Math.round(channel.mean)}, min=${channel.min}, max=${channel.max}`);
    });

    // 4. Test base64 encoding/decoding
    console.log('\n🔄 Testing base64 encoding:');
    const base64 = thumbnailSmall.toString('base64');
    console.log(`   ✅ Encoded to base64: ${base64.substring(0, 50)}...`);
    const decoded = Buffer.from(base64, 'base64');
    console.log(`   ✅ Decoded successfully: ${decoded.length} bytes`);

    console.log('\n✅ All image processing tests passed!');
    console.log('\n📁 Output files saved in: test/output/');

    // Test with user-provided image if available
    const userImagePath = process.argv[2];
    if (userImagePath && existsSync(userImagePath)) {
      console.log(`\n📸 Testing with user image: ${userImagePath}`);
      const userBuffer = await readFile(userImagePath);
      const userMetadata = await sharp(userBuffer).metadata();
      console.log(`   Format: ${userMetadata.format}`);
      console.log(`   Dimensions: ${userMetadata.width}x${userMetadata.height}`);
      
      const userThumbnail = await sharp(userBuffer)
        .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer();
      await writeFile('test/output/user-thumbnail.png', userThumbnail);
      console.log(`   ✅ Thumbnail saved: test/output/user-thumbnail.png`);
    }

  } catch (error: any) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

async function createTestImage(path: string) {
  const width = 800;
  const height = 600;
  
  await sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 100, b: 50, alpha: 1 }
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
          <circle cx="${width/2}" cy="${height/2}" r="100" fill="white" opacity="0.5" />
          <text x="${width/2}" y="${height/2}" font-size="48" fill="black" text-anchor="middle" dominant-baseline="middle">
            MCP Test
          </text>
        </svg>`
      ),
      top: 0,
      left: 0
    }
  ])
  .png()
  .toFile(path);
}

// Run the test
testImageExtractor().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});