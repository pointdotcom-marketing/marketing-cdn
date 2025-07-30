/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const CONTENT_TYPES = {
	js: 'application/javascript',
	css: 'text/css',
	html: 'text/html',
	json: 'application/json',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	svg: 'image/svg+xml',
	webp: 'image/webp',
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	eot: 'application/vnd.ms-fontobject',
	pdf: 'application/pdf',
	zip: 'application/zip',
	mp4: 'video/mp4',
};

// File types that should be previewed in browser
const PREVIEW_TYPES = new Set(['pdf', 'html', 'htm', 'jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'mp4']);

// File types that should be compressed
const COMPRESSIBLE_TYPES = new Set(['js', 'css', 'html', 'htm', 'json', 'svg', 'xml', 'txt']);

// Allowed origins for CORS requests
const ALLOWED_ORIGINS = [
	'https://www.point.dev',
	'https://point.com',
	'https://files.point.com',
	'https://scorecredit.com',
	'https://scorecredit.webflow.io',
];

// Generate unique filename by adding -1, -2, etc. if file exists
async function getUniqueFilename(bucket, originalName) {
	const extension = originalName.includes('.') ? originalName.split('.').pop() : '';
	const baseName = originalName.includes('.') ? originalName.split('.').slice(0, -1).join('.') : originalName;

	let filename = originalName;
	let counter = 1;

	// Check if file exists, if so, increment counter
	while (await bucket.get(filename)) {
		if (extension) {
			filename = `${baseName}-${counter}.${extension}`;
		} else {
			filename = `${baseName}-${counter}`;
		}
		counter++;
	}

	return filename;
}

// HTML for the upload form
const UPLOAD_FORM_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>File Upload - Point CDN</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 600px;
            margin: 50px auto;
            padding: 20px;
            background: #f5f5f5;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #333;
            margin-bottom: 20px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 5px;
            font-weight: 500;
            color: #555;
        }
        input[type="password"], input[type="file"] {
            width: 100%;
            padding: 12px;
            border: 2px solid #ddd;
            border-radius: 6px;
            font-size: 16px;
            box-sizing: border-box;
        }
        button {
            background: #007bff;
            color: white;
            padding: 12px 24px;
            border: none;
            border-radius: 6px;
            font-size: 16px;
            cursor: pointer;
            width: 100%;
        }
        button:hover {
            background: #0056b3;
        }
        .info {
            background: #e7f3ff;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
            color: #0056b3;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📁 Point CDN File Upload</h1>
        <div class="info">
            Upload files to the CDN. After upload, you'll get a shareable link.
        </div>
        <form method="POST" enctype="multipart/form-data">
            <div class="form-group">
                <label for="password">Password:</label>
                <input type="password" id="password" name="password" required placeholder="Enter upload password">
            </div>
            <div class="form-group">
                <label for="file">Choose File:</label>
                <input type="file" id="file" name="file" required>
            </div>
            <button type="submit">Upload File</button>
        </form>
    </div>
</body>
</html>
`;

// HTML for successful upload
function getSuccessHTML(filename, cdnUrl) {
	return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Upload Success - Point CDN</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 600px;
            margin: 50px auto;
            padding: 20px;
            background: #f5f5f5;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .success {
            background: #d4edda;
            color: #155724;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
        }
        .url-container {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 6px;
            margin: 20px 0;
        }
        .url-input {
            width: 100%;
            padding: 12px;
            border: 2px solid #ddd;
            border-radius: 6px;
            font-family: monospace;
            font-size: 14px;
            box-sizing: border-box;
        }
        .button-group {
            display: flex;
            gap: 10px;
            margin-top: 15px;
        }
        .btn {
            padding: 10px 20px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            text-decoration: none;
            text-align: center;
            font-size: 14px;
            flex: 1;
        }
        .btn-primary {
            background: #007bff;
            color: white;
        }
        .btn-secondary {
            background: #6c757d;
            color: white;
        }
        .btn:hover {
            opacity: 0.9;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>✅ Upload Successful!</h1>
        <div class="success">
            File "${filename}" has been uploaded successfully.
        </div>
        
        <div class="url-container">
            <label for="cdn-url"><strong>Your CDN URL:</strong></label>
            <input type="text" id="cdn-url" class="url-input" value="${cdnUrl}" readonly onclick="this.select()">
        </div>
        
        <div class="button-group">
            <button class="btn btn-primary" onclick="copyToClipboard()">📋 Copy URL</button>
            <a href="${cdnUrl}" target="_blank" class="btn btn-secondary">🔗 Open File</a>
        </div>
        
        <div style="margin-top: 20px; text-align: center;">
            <a href="/upload">← Upload Another File</a>
        </div>
    </div>
    
    <script>
        function copyToClipboard() {
            const urlInput = document.getElementById('cdn-url');
            urlInput.select();
            document.execCommand('copy');
            
            const btn = event.target;
            const originalText = btn.textContent;
            btn.textContent = '✅ Copied!';
            btn.style.background = '#28a745';
            
            setTimeout(() => {
                btn.textContent = originalText;
                btn.style.background = '#007bff';
            }, 2000);
        }
    </script>
</body>
</html>
`;
}

export default {
	async fetch(request, env) {
		try {
			// Parse the URL and get the pathname
			const url = new URL(request.url);
			const path = url.pathname.slice(1); // Remove leading slash

			// Handle upload route
			if (url.pathname === '/upload') {
				if (request.method === 'GET') {
					// Serve the upload form
					return new Response(UPLOAD_FORM_HTML, {
						headers: { 'Content-Type': 'text/html' },
					});
				}

				if (request.method === 'POST') {
					try {
						// Parse form data
						const formData = await request.formData();
						const password = formData.get('password');
						const file = formData.get('file');

						// Validate password
						if (!env.UPLOAD_PASSWORD || password !== env.UPLOAD_PASSWORD) {
							return new Response(
								`
								<!DOCTYPE html>
								<html>
								<head><title>Unauthorized</title><style>body{font-family:sans-serif;text-align:center;margin-top:50px;}</style></head>
								<body>
									<h1>🚫 Unauthorized</h1>
									<p>Invalid password. Please try again.</p>
									<a href="/upload">← Go Back</a>
								</body>
								</html>
							`,
								{
									status: 401,
									headers: { 'Content-Type': 'text/html' },
								}
							);
						}

						// Validate file
						if (!file || file.size === 0) {
							return new Response(
								`
								<!DOCTYPE html>
								<html>
								<head><title>No File</title><style>body{font-family:sans-serif;text-align:center;margin-top:50px;}</style></head>
								<body>
									<h1>📄 No File Selected</h1>
									<p>Please select a file to upload.</p>
									<a href="/upload">← Go Back</a>
								</body>
								</html>
							`,
								{
									status: 400,
									headers: { 'Content-Type': 'text/html' },
								}
							);
						}

						// Get unique filename (adds -1, -2, etc. if file exists)
						const filename = await getUniqueFilename(env.CDN_BUCKET, file.name);

						// Upload to R2
						await env.CDN_BUCKET.put(filename, file.stream(), {
							httpMetadata: {
								contentType: file.type || 'application/octet-stream',
							},
						});

						// Generate CDN URL
						const cdnUrl = `${url.origin}/${filename}`;

						// Return success page
						return new Response(getSuccessHTML(file.name, cdnUrl), {
							headers: { 'Content-Type': 'text/html' },
						});
					} catch (error) {
						console.error('Upload error:', error);
						return new Response(
							`
							<!DOCTYPE html>
							<html>
							<head><title>Upload Error</title><style>body{font-family:sans-serif;text-align:center;margin-top:50px;}</style></head>
							<body>
								<h1>❌ Upload Failed</h1>
								<p>There was an error uploading your file. Please try again.</p>
								<a href="/upload">← Go Back</a>
							</body>
							</html>
						`,
							{
								status: 500,
								headers: { 'Content-Type': 'text/html' },
							}
						);
					}
				}

				// Method not allowed
				return new Response('Method Not Allowed', { status: 405 });
			}

			// === EXISTING CDN LOGIC BELOW (UNCHANGED) ===
			const forceDownload = url.searchParams.get('download') === 'true';

			// Redirect root path to point.com
			if (!path) {
				return Response.redirect('https://point.com', 302);
			}

			// Get the file from R2
			const object = await env.CDN_BUCKET.get(path);

			if (!object) {
				// Redirect 404s to point.com
				return Response.redirect('https://point.com', 302);
			}

			// Check if request is from an allowed origin
			const origin = request.headers.get('Origin');
			const referer = request.headers.get('Referer');

			// Determine if this is a cross-origin request
			const isCrossOriginRequest = origin || referer;

			if (isCrossOriginRequest) {
				// Extract the origin from referer if origin header is not present
				const requestOrigin = origin || (referer ? new URL(referer).origin : null);

				// Check if the origin is allowed
				if (!ALLOWED_ORIGINS.includes(requestOrigin)) {
					return new Response('Forbidden', {
						status: 403,
						headers: {
							'Content-Type': 'text/plain',
						},
					});
				}
			}

			// Determine content type based on file extension
			const extension = path.split('.').pop().toLowerCase();
			const contentType = CONTENT_TYPES[extension] || 'application/octet-stream';

			// Check if this is a /code path request for compression
			const isCodePath = path.startsWith('code/');
			const isDirectNavigation = !request.headers.get('Referer') && request.headers.get('Accept')?.includes('text/html');
			const shouldCompress = isCodePath && COMPRESSIBLE_TYPES.has(extension) && !isDirectNavigation;

			// Prepare headers with caching
			const headers = new Headers({
				'Content-Type': contentType,
				'Cache-Control': 'public, max-age=31536000',
				ETag: object.httpEtag,
				'Last-Modified': object.uploaded.toUTCString(),
			});

			// Only set CORS headers for allowed origins
			if (origin && ALLOWED_ORIGINS.includes(origin)) {
				headers.set('Access-Control-Allow-Origin', origin);
				headers.set('Vary', 'Origin');
			}

			// Add Vary header for compressed content
			if (shouldCompress) {
				headers.set('Vary', 'Accept-Encoding');
			}

			// Set Content-Disposition based on file type and download parameter
			if (forceDownload) {
				headers.set('Content-Disposition', `attachment; filename="${path.split('/').pop()}"`);
			} else if (PREVIEW_TYPES.has(extension)) {
				headers.set('Content-Disposition', 'inline');
			}

			// Handle compression for text-based assets in /code path
			let responseBody = object.body;
			if (shouldCompress) {
				const acceptEncoding = request.headers.get('Accept-Encoding') || '';

				if (acceptEncoding.includes('gzip')) {
					try {
						// Use the proper pipeThrough approach for compression
						responseBody = object.body.pipeThrough(new CompressionStream('gzip'));
						headers.set('Content-Encoding', 'gzip');
					} catch (error) {
						console.error('Compression error:', error);
						// Fallback to uncompressed content
						responseBody = object.body;
					}
				}
			}

			// Handle MP4 files specially for streaming
			if (extension === 'mp4') {
				headers.set('Accept-Ranges', 'bytes');
				headers.set('Content-Length', object.size.toString());

				// Handle range requests
				if (request.headers.has('range')) {
					try {
						const range = request.headers.get('range');
						const size = object.size;
						const match = /bytes=(\d*)-(\d*)/.exec(range);

						if (!match) {
							return new Response('Invalid Range Header', {
								status: 400,
								headers: {
									'Accept-Ranges': 'bytes',
									'Content-Range': `bytes */${size}`,
								},
							});
						}

						let start = match[1] ? parseInt(match[1], 10) : 0;
						let end = match[2] ? parseInt(match[2], 10) : size - 1;

						// Handle open-ended ranges (e.g., bytes=0-)
						if (match[1] && !match[2]) {
							// For open-ended ranges, limit to 1MB chunks
							end = Math.min(start + 1024 * 1024 - 1, size - 1);
						}

						// Validate ranges
						if (start < 0 || start >= size || end >= size || start > end) {
							return new Response('Requested Range Not Satisfiable', {
								status: 416,
								headers: {
									'Content-Range': `bytes */${size}`,
									'Accept-Ranges': 'bytes',
								},
							});
						}

						const partial = await object.body.slice(start, end + 1);
						headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
						headers.set('Content-Length', (end - start + 1).toString());

						return new Response(partial, {
							status: 206,
							headers,
						});
					} catch (error) {
						console.error('Range request error:', error);
						// Fall back to sending the full file
						headers.set('Content-Range', `bytes */${object.size}`);
						return new Response(object.body, {
							headers,
						});
					}
				}
			}

			return new Response(responseBody, {
				headers,
			});
		} catch (error) {
			console.error(error);
			return new Response('Internal Server Error', { status: 500 });
		}
	},
};
