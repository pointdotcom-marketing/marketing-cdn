# Marketing CDN

A content delivery network (CDN) powered by Cloudflare Workers and R2 storage that serves Point.com marketing assets and site code from `files.point.com`.

## Overview

This Worker only serves files. Uploading, replacing, renaming, deleting, and browsing CDN files (and the PDC code browser) live in the [marketing-tools hub](https://marketing-tools.ops-1df.workers.dev) behind Google sign-in and per-user permissions. `files.point.com/upload`, `/browse`, and `/code` redirect there.

## Key Features

### 🚀 Core CDN Functionality

- **Global Edge Network**: Leverages Cloudflare's worldwide infrastructure
- **R2 Storage Integration**: Scalable object storage with S3-compatible API
- **Custom Domain Support**: Serves assets from `files.point.com`
- **Intelligent Caching**: Optimized cache headers with ETags and Last-Modified

### 📁 File Management (marketing-tools hub)

- **Upload & replace**: any signed-in point.com account; uploads never overwrite (duplicate names get `-1`, `-2`, …)
- **Rename, delete, restore, redirects**: people granted *Manage CDN files* on the hub Admin page
- **Rename redirects**: a rename can leave an empty placeholder at the old key (`cdn-redirect-to` custom metadata); this Worker answers it with a `no-store` 302 to the new key
- **Trash**: deleted uploads move under `_trash/`, which this Worker never serves

### 🔒 Security & Access Control

- **CORS Protection**: Whitelist-based origin validation for `code/` assets
- **No credentials here**: this Worker has no admin routes, passwords, or sessions
- **Asset Path Validation**: Redirect metadata is ignored in protected folders, so it can never redirect site code

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

File management: marketing-tools hub ──▶ same R2 bucket
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

Use **Upload & browse files** in the [marketing-tools hub](https://marketing-tools.ops-1df.workers.dev/tools/cdn-files) (`files.point.com/upload` redirects there) and sign in with your point.com Google account.

Uploads never overwrite an existing object. If `logo.png` is already on the CDN, the new file is stored as `logo-1.png`. To keep the same URL, use **Replace** on that file. People with *Manage CDN files* can also rename (optionally leaving a redirect), delete to Trash, and restore.

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
CDN_PUBLIC_BASE=https://files.point.com

# CORS Configuration (automatically configured)
ALLOWED_ORIGINS=https://www.point.dev,https://point.com,https://files.point.com,https://scorecredit.com,https://scorecredit.webflow.io
```

Cache purges for replace, rename, and delete happen in the marketing-tools hub, which holds the zone credentials.

### Wrangler Configuration (`wrangler.toml`)

```toml
name = "marketing-cdn"
main = "src/index.js"
compatibility_date = "2024-12-05"
compatibility_flags = ["nodejs_compat"]
workers_dev = true
preview_urls = true

[[routes]]
pattern = "files.point.com"
zone_name = "point.com"
custom_domain = true
enabled = true
previews_enabled = false

[[r2_buckets]]
binding = "CDN_BUCKET"
bucket_name = "marketing-cdn"

[vars]
CDN_PUBLIC_BASE = "https://files.point.com"

[observability]
enabled = true
head_sampling_rate = 1
```

## Development

### Prerequisites

- Node.js 22+ or Bun
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

3. **Start development server:**

```bash
npm run dev
# or
bun run dev
```

4. **Deploy to production** (serving changes: upload a version and check it with `Cloudflare-Workers-Version-Overrides` before shifting traffic; see AGENTS.md):

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
- **Public Font Assets**: Files under `code/staging/fonts/` and
  `code/prod/fonts/` return `Access-Control-Allow-Origin: *`
- **Referer Fallback**: Uses referer header when origin is not present
- **Vary Headers**: Proper cache variation for cross-origin requests

### Error Handling

- **404 Redirects**: Automatically redirects missing files to point.com
- **Trash and redirects**: `_trash/` paths read as missing; rename placeholders answer 302 with `no-store`
- **Range Request Errors**: Graceful fallback for invalid range requests

## Security Best Practices

- **No admin surface**: management (and its Google sign-in and permissions) lives in the marketing-tools hub; this Worker holds no credentials
- **Public Asset URLs**: Direct file URLs (e.g. `https://files.point.com/logo.png`) remain publicly reachable
- **Origin Restrictions**: CORS policy prevents unauthorized cross-origin access
- **Error Sanitization**: No sensitive information exposed in error messages

## Monitoring & Observability

- **Cloudflare Analytics**: Built-in request analytics and performance metrics
- **Error Logging**: Comprehensive error logging with console.error()
- **Performance Metrics**: Response time and cache hit rate monitoring

## Important Links

- [Cloudflare Workers Dashboard](https://dash.cloudflare.com/workers/services/view/marketing-cdn)
- [R2 Bucket Dashboard](https://dash.cloudflare.com/r2/default/buckets/marketing-cdn)
- [Upload & browse files (marketing-tools hub)](https://marketing-tools.ops-1df.workers.dev/tools/cdn-files)

## Integration with PDC Code

This CDN works seamlessly with the `pdc-code` build system:

- **Staging Assets**: `https://files.point.com/code/staging/`
- **Production Assets**: `https://files.point.com/code/prod/`
- **Automatic Deployment**: GitHub Actions in pdc-code automatically upload built assets
- **Cache Purging**: Automated cache invalidation for updated files
