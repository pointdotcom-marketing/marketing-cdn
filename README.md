# Marketing CDN

A sophisticated content delivery network (CDN) powered by Cloudflare Workers and R2 storage for serving Point.com marketing assets with advanced features including file uploads, compression, and streaming capabilities.

## Overview

This CDN serves marketing assets through Cloudflare's global edge network, providing fast and reliable content delivery. It uses Cloudflare Workers for intelligent request handling, R2 for scalable asset storage, and includes a web-based upload interface for easy asset management.

## Key Features

### 🚀 Core CDN Functionality

- **Global Edge Network**: Leverages Cloudflare's worldwide infrastructure
- **R2 Storage Integration**: Scalable object storage with S3-compatible API
- **Custom Domain Support**: Serves assets from `files.point.com`
- **Intelligent Caching**: Optimized cache headers with ETags and Last-Modified

### 📤 File Upload System

- **Web-based Upload Interface**: Accessible at `/upload` with password protection
- **Automatic File Deduplication**: Prevents overwrites by adding incremental suffixes (-1, -2, etc.)
- **Success Page with URL Copying**: User-friendly upload confirmation with shareable links
- **Multiple Upload Methods**: Web interface, Cloudflare Dashboard, AWS S3 API, or Wrangler CLI

### 🔒 Security & Access Control

- **CORS Protection**: Whitelist-based origin validation for cross-origin requests
- **Password-Protected Uploads**: Secure file upload with configurable authentication
- **Asset Path Validation**: Prevents unauthorized access patterns
- **Origin-based Access Control**: Restricts access based on request origin

### ⚡ Performance Optimizations

- **Gzip Compression**: Automatic compression for text-based assets in `/code` directory
- **Content Type Detection**: Proper MIME type headers for 20+ file formats
- **Preview vs Download Modes**: Intelligent content disposition based on file type
- **Streaming Support**: Range request handling for video files (MP4)

### 🎥 Media Streaming

- **MP4 Video Streaming**: Full range request support for efficient video delivery
- **Chunked Transfer**: 1MB chunk optimization for large files
- **Accept-Ranges Headers**: Proper HTTP range request handling

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Client Apps   │───▶│ Cloudflare Edge  │───▶│   R2 Storage    │
│  (point.com,    │    │    (Workers)     │    │  (marketing-    │
│ scorecredit.com)│    │                  │    │     cdn)        │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                              │
                              ▼
                       ┌──────────────────┐
                       │  Upload Interface│
                       │   (/upload)      │
                       └──────────────────┘
```

## Supported File Types

### Images

- PNG, JPG/JPEG, GIF, SVG, WebP

### Documents

- PDF, HTML, JSON

### Media

- MP4 (with streaming support)

### Web Assets

- JavaScript, CSS, HTML

### Fonts

- WOFF, WOFF2, TTF, EOT

### Archives

- ZIP

## Usage

### Uploading Assets

#### Web Interface (Recommended)

1. Navigate to `https://files.point.com/upload`
2. Enter the upload password
3. Select your file
4. Click "Upload File"
5. Copy the generated CDN URL

#### Alternative Methods

- **Cloudflare Dashboard**: Direct R2 bucket management
- **AWS S3 API**: S3-compatible uploads using AWS CLI or SDKs
- **Wrangler CLI**: Command-line uploads via `wrangler r2 object put`

### Accessing Assets

Assets are accessible through the CDN URL structure:

```
https://files.point.com/{asset-path}
```

**Examples:**

- `https://files.point.com/images/logo.png`
- `https://files.point.com/code/staging/components/nav.js`
- `https://files.point.com/videos/demo.mp4`

### Special URL Parameters

- **Force Download**: Add `?download=true` to force file download
- **Range Requests**: Automatic for MP4 files to enable streaming

## Configuration

### Environment Variables

Required environment variables in your Cloudflare Worker:

```bash
# R2 Bucket Configuration
CDN_BUCKET=marketing-cdn

# Upload Security
UPLOAD_PASSWORD=your-secure-password

# CORS Configuration (automatically configured)
ALLOWED_ORIGINS=https://www.point.dev,https://point.com,https://files.point.com,https://scorecredit.com,https://scorecredit.webflow.io
```

### Wrangler Configuration (`wrangler.toml`)

```toml
name = "marketing-cdn"
main = "src/index.js"
compatibility_date = "2024-12-05"
compatibility_flags = ["nodejs_compat"]

[[r2_buckets]]
binding = "CDN_BUCKET"
bucket_name = "marketing-cdn"

[observability]
enabled = true
head_sampling_rate = 1
```

## Development

### Prerequisites

- Node.js 18+ or Bun
- Cloudflare account with Workers and R2 enabled
- Wrangler CLI

### Setup

1. **Install dependencies:**

```bash
npm install
# or
bun install
```

2. **Login to Cloudflare:**

```bash
wrangler login
```

3. **Configure environment variables:**

```bash
wrangler secret put UPLOAD_PASSWORD
```

4. **Start development server:**

```bash
npm run dev
# or
bun run dev
```

5. **Deploy to production:**

```bash
npm run deploy
# or
bun run deploy
```

### Development Commands

```bash
# Start local development server
npm run dev

# Deploy to Cloudflare Workers
npm run deploy

# Alternative development command
wrangler dev
```

## Advanced Features

### Compression Logic

- **Automatic Gzip**: Applied to JS, CSS, HTML, JSON, SVG, XML, TXT files in `/code` directory
- **Smart Compression**: Only compresses when `Accept-Encoding: gzip` is present
- **Fallback Handling**: Gracefully falls back to uncompressed content on compression errors

### CORS Handling

- **Origin Validation**: Checks against predefined allowed origins list
- **Referer Fallback**: Uses referer header when origin is not present
- **Vary Headers**: Proper cache variation for cross-origin requests

### Error Handling

- **404 Redirects**: Automatically redirects missing files to point.com
- **Upload Errors**: User-friendly error pages for upload failures
- **Range Request Errors**: Graceful fallback for invalid range requests

## Security Best Practices

- **Password Protection**: Upload interface requires authentication
- **Origin Restrictions**: CORS policy prevents unauthorized cross-origin access
- **Input Validation**: File size and type validation on uploads
- **Error Sanitization**: No sensitive information exposed in error messages

## Monitoring & Observability

- **Cloudflare Analytics**: Built-in request analytics and performance metrics
- **Error Logging**: Comprehensive error logging with console.error()
- **Upload Tracking**: Success/failure tracking for file uploads
- **Performance Metrics**: Response time and cache hit rate monitoring

## Important Links

- [Cloudflare Workers Dashboard](https://dash.cloudflare.com/workers/services/view/marketing-cdn)
- [R2 Bucket Dashboard](https://dash.cloudflare.com/r2/default/buckets/marketing-cdn)
- [Upload Interface](https://files.point.com/upload)

## Integration with PDC Code

This CDN works seamlessly with the `pdc-code` build system:

- **Staging Assets**: `https://files.point.com/code/staging/`
- **Production Assets**: `https://files.point.com/code/prod/`
- **Automatic Deployment**: GitHub Actions in pdc-code automatically upload built assets
- **Cache Purging**: Automated cache invalidation for updated files
