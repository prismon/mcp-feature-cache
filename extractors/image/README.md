# Image/Video Feature Extractor

MCP tool for extracting features from images and videos.

## Features

### Image Features
- **Thumbnails**: Small (150x150), Medium (400x400), Large (1920x1080) in PNG format
- **Dimensions**: Original width and height
- **Format**: Image format detection
- **Dominant Colors**: Color analysis with channel statistics
- **EXIF Data**: Metadata extraction when available
- **File Size**: Original file size

### Video Features  
- **Timeline Snapshots**: Frames at 10% intervals (0%, 10%, 20%...90%)
- **Main Thumbnail**: Frame from the middle of the video
- **Duration**: Total video length in seconds
- **Dimensions**: Video resolution
- **FPS**: Frame rate
- **File Size**: Original file size

## Requirements

- **sharp**: For image processing (automatically installed)
- **ffmpeg**: For video processing (must be installed separately)

### Installing ffmpeg

**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install ffmpeg
```

**macOS:**
```bash
brew install ffmpeg
```

**Windows:**
Download from https://ffmpeg.org/download.html

## Usage

### As MCP Tool

The extractor exposes two MCP tools:
- `extract_image_features`: Process image files
- `extract_video_features`: Process video files

### Standalone Test

```bash
# Test with generated image
npm run test:smoke

# Test with your own image
npm run test:smoke /path/to/image.jpg

# Test with video
npm run test:smoke /path/to/video.mp4
```

## Supported Formats

### Images
- JPEG/JPG
- PNG
- GIF
- WebP
- TIFF
- BMP
- SVG

### Videos (requires ffmpeg)
- MP4
- AVI
- MOV
- MKV
- WebM
- FLV
- WMV

## Output Format

All features are returned with:
- `key`: Feature identifier (e.g., "image.thumbnail.small")
- `value`: Feature data (base64 for binary, JSON for structured data)
- `type`: Data type (binary, json, text, number)
- `ttl`: Time to live in seconds
- `metadata`: Additional information about the feature