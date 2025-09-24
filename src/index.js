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

// Get list of files from R2 bucket with optional search filter
async function getFilesList(bucket, search = '') {
	try {
		const objects = await bucket.list();
		let files = objects.objects.map((obj) => obj.key);

		// Filter by search term if provided (case-insensitive)
		if (search) {
			const searchLower = search.toLowerCase();
			files = files.filter((filename) => filename.toLowerCase().includes(searchLower));
		}

		// Sort alphabetically
		files.sort();

		return files;
	} catch (error) {
		console.error('Error listing files:', error);
		return [];
	}
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

// HTML for the browse password form
function getBrowsePasswordHTML(errorMessage = '') {
	return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>File Browser Auth - Point CDN</title>
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
            text-align: center;
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
        input[type="password"] {
            width: 100%;
            padding: 12px;
            border: 2px solid #ddd;
            border-radius: 6px;
            font-size: 16px;
            box-sizing: border-box;
        }
        input[type="password"]:focus {
            outline: none;
            border-color: #007bff;
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
        .error {
            background: #f8d7da;
            color: #721c24;
            padding: 10px;
            border-radius: 6px;
            margin-bottom: 20px;
            border: 1px solid #f5c6cb;
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
        <h1>🔐 Point CDN File Browser</h1>
        ${errorMessage ? `<div class="error">${errorMessage}</div>` : ''}
        <div class="info">
            Enter the password to access the file browser and search CDN files.
        </div>
        <form method="POST">
            <div class="form-group">
                <label for="password">Password:</label>
                <input type="password" id="password" name="password" required placeholder="Enter access password" autofocus>
            </div>
            <button type="submit">Access File Browser</button>
        </form>
    </div>
</body>
</html>
`;
}

// HTML for the file browser interface
function getBrowseHTML(origin, password) {
	return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>File Browser - Point CDN</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 800px;
            margin: 0 auto;
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
            text-align: center;
        }
        .search-container {
            margin-bottom: 20px;
        }
        .search-input {
            width: 100%;
            padding: 12px;
            border: 2px solid #ddd;
            border-radius: 6px;
            font-size: 16px;
            box-sizing: border-box;
        }
        .search-input:focus {
            outline: none;
            border-color: #007bff;
        }
        .file-list {
            max-height: 500px;
            overflow-y: auto;
            border: 1px solid #ddd;
            border-radius: 6px;
        }
        .file-item {
            display: flex;
            align-items: center;
            padding: 12px 15px;
            border-bottom: 1px solid #eee;
            transition: background-color 0.2s;
        }
        .file-item:hover {
            background-color: #f8f9fa;
        }
        .file-item:last-child {
            border-bottom: none;
        }
        .file-name {
            flex: 1;
            font-family: monospace;
            font-size: 14px;
            word-break: break-all;
        }
        .file-url {
            flex: 2;
            font-family: monospace;
            font-size: 12px;
            color: #666;
            margin: 0 10px;
            word-break: break-all;
        }
        .copy-btn {
            background: #007bff;
            color: white;
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            transition: background-color 0.2s;
        }
        .copy-btn:hover {
            background: #0056b3;
        }
        .copy-btn.copied {
            background: #28a745;
        }
        .no-files {
            text-align: center;
            padding: 40px;
            color: #666;
        }
        .loading {
            text-align: center;
            padding: 40px;
            color: #666;
        }
        .nav-links {
            text-align: center;
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid #eee;
        }
        .nav-links a {
            color: #007bff;
            text-decoration: none;
            margin: 0 10px;
        }
        .nav-links a:hover {
            text-decoration: underline;
        }
        .stats {
            text-align: center;
            color: #666;
            font-size: 14px;
            margin-bottom: 20px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔍 Point CDN File Browser</h1>

        <div class="search-container">
            <input type="text" id="search-input" class="search-input" placeholder="Search files... (press Enter or wait 300ms)" autocomplete="off">
        </div>

        <div id="stats" class="stats">Loading files...</div>

        <div id="file-list" class="file-list">
            <div class="loading">Loading files...</div>
        </div>

        <div class="nav-links">
            <a href="/upload">📤 Upload Files</a>
            <a href="${origin}">🏠 Home</a>
        </div>
    </div>

    <script>
        let searchTimeout;
        const searchInput = document.getElementById('search-input');
        const fileList = document.getElementById('file-list');
        const stats = document.getElementById('stats');
        const password = '${password}';

        async function loadFiles(search = '') {
            try {
                fileList.innerHTML = '<div class="loading">Loading files...</div>';

                const response = await fetch(\`/api/files?password=\${encodeURIComponent(password)}&search=\${encodeURIComponent(search)}\`);
                const data = await response.json();

                if (data.error) {
                    fileList.innerHTML = '<div class="no-files">Error loading files</div>';
                    stats.textContent = 'Error loading files';
                    return;
                }

                const files = data.files || [];

                if (files.length === 0) {
                    fileList.innerHTML = '<div class="no-files">No files found</div>';
                    stats.textContent = search ? \`No files match "\${search}"\` : 'No files in CDN';
                    return;
                }

                stats.textContent = \`Found \${files.length} file\${files.length === 1 ? '' : 's'}\${search ? \` matching "\${search}"\` : ''}\`;

                fileList.innerHTML = files.map(url => {
                    const filename = url.split('/').pop();
                    return \`
                        <div class="file-item">
                            <div class="file-name" title="\${filename}">\${filename}</div>
                            <div class="file-url" title="\${url}">\${url}</div>
                            <button class="copy-btn" onclick="copyToClipboard('\${url}', this)">📋 Copy</button>
                        </div>
                    \`;
                }).join('');

            } catch (error) {
                console.error('Error loading files:', error);
                fileList.innerHTML = '<div class="no-files">Error loading files</div>';
                stats.textContent = 'Error loading files';
            }
        }

        function copyToClipboard(text, button) {
            navigator.clipboard.writeText(text).then(() => {
                const originalText = button.textContent;
                button.textContent = '✅ Copied!';
                button.classList.add('copied');

                setTimeout(() => {
                    button.textContent = originalText;
                    button.classList.remove('copied');
                }, 2000);
            }).catch(err => {
                console.error('Failed to copy:', err);
                // Fallback for older browsers
                const textArea = document.createElement('textarea');
                textArea.value = text;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);

                const originalText = button.textContent;
                button.textContent = '✅ Copied!';
                button.classList.add('copied');

                setTimeout(() => {
                    button.textContent = originalText;
                    button.classList.remove('copied');
                }, 2000);
            });
        }

        // Load all files initially
        loadFiles();

        // Handle search input
        searchInput.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                loadFiles(searchInput.value);
            }, 300);
        });

        // Handle Enter key
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                clearTimeout(searchTimeout);
                loadFiles(searchInput.value);
            }
        });
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

			// Handle browse route
			if (url.pathname === '/browse') {
				if (request.method === 'GET') {
					// Check for password in query params
					const password = url.searchParams.get('password');

					// Validate password - use same password as upload for consistency
					if (!env.UPLOAD_PASSWORD || password !== env.UPLOAD_PASSWORD) {
						// Serve password form
						return new Response(getBrowsePasswordHTML(), {
							headers: { 'Content-Type': 'text/html' },
						});
					}

					// Password valid, serve the file browser
					return new Response(getBrowseHTML(url.origin, password), {
						headers: { 'Content-Type': 'text/html' },
					});
				}

				if (request.method === 'POST') {
					try {
						// Parse form data
						const formData = await request.formData();
						const password = formData.get('password');

						// Validate password
						if (!env.UPLOAD_PASSWORD || password !== env.UPLOAD_PASSWORD) {
							return new Response(getBrowsePasswordHTML('Invalid password. Please try again.'), {
								status: 401,
								headers: { 'Content-Type': 'text/html' },
							});
						}

						// Password valid, redirect to browse with password
						return Response.redirect(`${url.origin}/browse?password=${encodeURIComponent(password)}`, 302);
					} catch (error) {
						console.error('Browse auth error:', error);
						return new Response(getBrowsePasswordHTML('An error occurred. Please try again.'), {
							status: 500,
							headers: { 'Content-Type': 'text/html' },
						});
					}
				}

				// Method not allowed
				return new Response('Method Not Allowed', { status: 405 });
			}

			// Handle files API route for dynamic search
			if (url.pathname === '/api/files') {
				if (request.method === 'GET') {
					try {
						// Validate password for API access - use same password as upload
						const password = url.searchParams.get('password');
						if (!env.UPLOAD_PASSWORD || password !== env.UPLOAD_PASSWORD) {
							return new Response(JSON.stringify({ error: 'Unauthorized' }), {
								status: 401,
								headers: { 'Content-Type': 'application/json' },
							});
						}

						const search = url.searchParams.get('search') || '';
						const files = await getFilesList(env.CDN_BUCKET, search);
						const cdnUrls = files.map((filename) => `${url.origin}/${filename}`);

						return new Response(JSON.stringify({ files: cdnUrls }), {
							headers: {
								'Content-Type': 'application/json',
								'Cache-Control': 'no-cache',
							},
						});
					} catch (error) {
						console.error('Files API error:', error);
						return new Response(JSON.stringify({ error: 'Failed to fetch files' }), {
							status: 500,
							headers: { 'Content-Type': 'application/json' },
						});
					}
				}

				// Method not allowed
				return new Response('Method Not Allowed', { status: 405 });
			}

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

			// Disable manual compression for /code path - let Cloudflare handle automatic compression
			const shouldCompress = false;

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

			// Vary header removed - no manual compression

			// Set Content-Disposition based on file type and download parameter
			if (forceDownload) {
				headers.set('Content-Disposition', `attachment; filename="${path.split('/').pop()}"`);
			} else if (PREVIEW_TYPES.has(extension)) {
				headers.set('Content-Disposition', 'inline');
			}

			// No manual compression - let Cloudflare handle automatic compression
			let responseBody = object.body;

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

						const length = end - start + 1;
						const ranged = await env.CDN_BUCKET.get(path, { range: { offset: start, length } });
						if (!ranged || !ranged.body) {
							return new Response('Requested Range Not Satisfiable', {
								status: 416,
								headers: {
									'Accept-Ranges': 'bytes',
									'Content-Range': `bytes */${size}`,
								},
							});
						}

						headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
						headers.set('Content-Length', String(length));

						return new Response(ranged.body, {
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
