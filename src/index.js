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

// Check if origin is a valid Webflow branch containing "new-point"
function isValidWebflowBranch(origin) {
	if (!origin || typeof origin !== 'string') return false;

	try {
		const url = new URL(origin);
		// Must be a webflow.io domain
		if (!url.hostname.endsWith('.webflow.io')) return false;

		// Check if subdomain contains "new-point" (case-insensitive)
		const subdomain = url.hostname.replace('.webflow.io', '');
		return subdomain.toLowerCase().includes('new-point');
	} catch {
		return false;
	}
}

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

// Simple fuzzy search scoring function
function fuzzyScore(filename, query) {
	if (!query) return 1; // Perfect score if no query

	const filenameLower = filename.toLowerCase();
	const queryLower = query.toLowerCase();

	// Exact substring match gets highest score
	if (filenameLower.includes(queryLower)) {
		return 1;
	}

	// Split filename into searchable parts (by common delimiters)
	const filenameParts = filenameLower.split(/[-_.\/]/);
	const queryParts = queryLower.split(/[\s-_]/);

	// Check if all query parts are found in any filename parts
	let totalScore = 0;
	let matchedParts = 0;

	for (const queryPart of queryParts) {
		if (queryPart.length === 0) continue;

		let bestPartScore = 0;

		for (const filenamePart of filenameParts) {
			const score = fuzzyMatchPart(filenamePart, queryPart);
			bestPartScore = Math.max(bestPartScore, score);
		}

		if (bestPartScore > 0.3) {
			// Minimum threshold for a part match
			totalScore += bestPartScore;
			matchedParts++;
		}
	}

	// Return average score across matched parts, or 0 if no parts matched
	return matchedParts > 0 ? totalScore / queryParts.length : 0;
}

// Helper function to score matching between individual parts
function fuzzyMatchPart(filenamePart, queryPart) {
	if (filenamePart.includes(queryPart)) return 1;

	let score = 0;
	let queryIndex = 0;
	let consecutiveMatches = 0;

	for (let i = 0; i < filenamePart.length && queryIndex < queryPart.length; i++) {
		if (filenamePart[i] === queryPart[queryIndex]) {
			score += 0.1; // Base points for each character match
			score += (filenamePart.length - i) * 0.01; // Bonus for earlier matches
			consecutiveMatches++;
			score += consecutiveMatches * 0.05; // Bonus for consecutive matches
			queryIndex++;
		} else {
			consecutiveMatches = 0;
		}
	}

	// Normalize score by query length and add completion bonus
	const completionRatio = queryIndex / queryPart.length;
	score = score * completionRatio;

	// Bonus for completing the entire query
	if (queryIndex === queryPart.length) {
		score += 0.3;
	}

	return Math.min(score, 1); // Cap at 1.0
}

// Get list of files from R2 bucket with optional search, environment, and folder filters
async function getFilesList(bucket, search = '', env = 'all', folder = 'all') {
	try {
		const objects = await bucket.list();
		let files = objects.objects.map((obj) => obj.key);

		// Only include files within the 'code/' directory and its subdirectories
		files = files.filter((filename) => filename.startsWith('code/'));

		// Filter by environment (staging/prod/all)
		if (env === 'staging') {
			files = files.filter((filename) => filename.startsWith('code/staging/'));
		} else if (env === 'prod') {
			files = files.filter((filename) => filename.startsWith('code/') && !filename.startsWith('code/staging/'));
		}

		// Extract unique folders from file paths (e.g., code/staging/js/app.js -> js or code/prod/js/app.js -> js)
		const foldersSet = new Set();
		files.forEach((filename) => {
			// Remove code/staging/ or code/prod/ prefix
			let pathAfterEnv = filename;
			if (filename.startsWith('code/staging/')) {
				pathAfterEnv = filename.substring('code/staging/'.length);
			} else if (filename.startsWith('code/prod/')) {
				pathAfterEnv = filename.substring('code/prod/'.length);
			} else if (filename.startsWith('code/')) {
				pathAfterEnv = filename.substring('code/'.length);
			}

			// Extract first directory (folder) from remaining path
			const parts = pathAfterEnv.split('/');
			if (parts.length > 1 && parts[0]) {
				foldersSet.add(parts[0]);
			}
		});

		const folders = Array.from(foldersSet).sort();

		// Filter by folder if specified
		if (folder !== 'all') {
			files = files.filter((filename) => {
				let pathAfterEnv = filename;
				if (filename.startsWith('code/staging/')) {
					pathAfterEnv = filename.substring('code/staging/'.length);
				} else if (filename.startsWith('code/prod/')) {
					pathAfterEnv = filename.substring('code/prod/'.length);
				} else if (filename.startsWith('code/')) {
					pathAfterEnv = filename.substring('code/'.length);
				}
				const folderName = pathAfterEnv.split('/')[0];
				return folderName === folder;
			});
		}

		// Filter by search term if provided (fuzzy search)
		if (search) {
			files = files.filter((filename) => {
				const score = fuzzyScore(filename, search);
				return score > 0.2; // Minimum threshold for fuzzy matches
			});
		}

		// Sort alphabetically
		files.sort();

		return { files, folders };
	} catch (error) {
		console.error('Error listing files:', error);
		return { files: [], folders: [] };
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
    <title>🔐 PDC Custom Code Browser</title>
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
        <h1>🔐 PDC Custom Code Browser</h1>
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
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }
        @media (max-width: 768px) {
            body {
                max-width: 100%;
                padding: 10px;
            }
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.08);
        }
        @media (max-width: 768px) {
            .container {
                padding: 20px;
                border-radius: 8px;
            }
        }
        .header-section {
            display: flex;
            align-items: center;
            gap: 20px;
            margin-bottom: 25px;
            flex-wrap: nowrap;
            overflow: hidden;
        }
        h1 {
            color: #333;
            margin: 0;
            flex: 0 0 auto;
            white-space: nowrap;
            font-size: clamp(1.5rem, 3vw, 2rem);
        }
        .search-container {
            flex: 1;
            min-width: 250px;
            max-width: 600px;
        }
        .search-input {
            width: 100%;
            padding: 12px 16px;
            border: 2px solid #ddd;
            border-radius: 8px;
            font-size: 16px;
            box-sizing: border-box;
            transition: border-color 0.2s;
        }
        .search-input:focus {
            outline: none;
            border-color: #007bff;
            box-shadow: 0 0 0 3px rgba(0,123,255,0.1);
        }
        @media (max-width: 1024px) {
            .header-section {
                gap: 15px;
            }
            h1 {
                font-size: clamp(1.25rem, 2.5vw, 1.75rem);
            }
            .search-container {
                min-width: 200px;
            }
        }
        @media (max-width: 768px) {
            .header-section {
                flex-direction: column;
                align-items: stretch;
                gap: 15px;
                flex-wrap: wrap;
            }
            h1 {
                text-align: center;
                margin-bottom: 10px;
                font-size: 1.5rem;
            }
            .search-container {
                flex: none;
                min-width: auto;
                max-width: none;
            }
        }
        .file-list {
            max-height: 600px;
            overflow-y: auto;
            border: 1px solid #ddd;
            border-radius: 8px;
            background: #fafafa;
        }
        .file-item {
            display: flex;
            align-items: center;
            padding: 14px 20px;
            border-bottom: 1px solid #eee;
            transition: background-color 0.2s;
            gap: 15px;
        }
        .file-item:hover {
            background-color: #f8f9fa;
        }
        .file-item:last-child {
            border-bottom: none;
        }
        .file-name {
            flex: 3;
            font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
            font-size: 14px;
            word-break: break-all;
            min-width: 200px;
        }
        .file-url {
            flex: 4;
            font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace;
            font-size: 13px;
            color: #666;
            word-break: break-all;
            background: #f8f9fa;
            padding: 4px 8px;
            border-radius: 4px;
            border: 1px solid #e9ecef;
            min-width: 300px;
            cursor: pointer;
            transition: all 0.2s;
            user-select: none;
        }
        .file-url:hover {
            background: #e9ecef;
            border-color: #007bff;
            color: #007bff;
        }
        .file-url.copied {
            background: #d4edda !important;
            border-color: #28a745 !important;
            color: #155724 !important;
        }
        .copy-btn {
            background: #007bff;
            color: white;
            border: none;
            padding: 8px 14px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.2s;
            white-space: nowrap;
            flex-shrink: 0;
        }
        .copy-btn:hover {
            background: #0056b3;
            transform: translateY(-1px);
        }
		.copy-btn.copied {
			background: #28a745;
		}
        @media (max-width: 1024px) {
            .file-item {
                flex-direction: column;
                align-items: stretch;
                gap: 10px;
                padding: 12px 15px;
            }
            .file-name {
                flex: none;
                min-width: auto;
            }
            .file-url {
                flex: none;
                min-width: auto;
                font-size: 12px;
            }
            .copy-btn {
                align-self: flex-end;
                padding: 6px 12px;
                font-size: 12px;
            }
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
            display: flex;
            justify-content: center;
            gap: 20px;
            margin-top: 25px;
            padding-top: 20px;
            border-top: 1px solid #eee;
            flex-wrap: wrap;
        }
        .nav-links a {
            color: #007bff;
            text-decoration: none;
            font-weight: 500;
            padding: 8px 16px;
            border-radius: 6px;
            transition: all 0.2s;
        }
        .nav-links a:hover {
            background: #f8f9fa;
            text-decoration: none;
            transform: translateY(-1px);
        }
        @media (max-width: 768px) {
            .nav-links {
                gap: 15px;
            }
            .nav-links a {
                padding: 6px 12px;
                font-size: 14px;
            }
        }
        .stats {
            color: #666;
            font-size: 14px;
            font-weight: 500;
            white-space: nowrap;
        }
        .controls-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            gap: 20px;
            flex-wrap: wrap;
        }
        .env-filters {
            display: flex;
            gap: 8px;
            flex-shrink: 0;
        }
        .env-filter-btn {
            padding: 8px 14px;
            border: 2px solid #ddd;
            background: white;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.2s;
            white-space: nowrap;
        }
        .env-filter-btn:hover {
            border-color: #007bff;
            transform: translateY(-1px);
        }
        .env-filter-btn.active {
            background: #007bff;
            color: white;
            border-color: #007bff;
            box-shadow: 0 2px 4px rgba(0,123,255,0.2);
        }
        @media (max-width: 768px) {
            .controls-bar {
                flex-direction: column;
                align-items: stretch;
                gap: 15px;
            }
            .env-filters {
                justify-content: center;
                flex-wrap: wrap;
            }
        }
        .env-badge {
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            margin-right: 8px;
        }
        .env-badge.prod {
            background: #28a745;
            color: white;
        }
        .env-badge.staging {
            background: #ffc107;
            color: #212529;
        }
        .folder-badge {
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 11px;
            font-weight: 600;
            background: #6c757d;
            color: white;
            cursor: pointer;
            margin-right: 8px;
            transition: all 0.2s;
        }
        .folder-badge:hover {
            background: #5a6268;
            transform: translateY(-1px);
        }
        .folder-filters {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            margin-top: 10px;
        }
        .folder-filter-btn {
            padding: 8px 14px;
            border: 2px solid #ddd;
            background: white;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.2s;
            white-space: nowrap;
        }
        .folder-filter-btn:hover {
            border-color: #6c757d;
            transform: translateY(-1px);
        }
        .folder-filter-btn.active {
            background: #6c757d;
            color: white;
            border-color: #6c757d;
            box-shadow: 0 2px 4px rgba(108,117,125,0.2);
        }
        .context-menu {
            position: fixed;
            background: white;
            border: 1px solid #ddd;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            padding: 4px 0;
            z-index: 1000;
            min-width: 150px;
            display: none;
        }
        .context-menu.show {
            display: block;
        }
        .context-menu-item {
            padding: 10px 16px;
            cursor: pointer;
            font-size: 14px;
            transition: background-color 0.15s;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .context-menu-item:hover {
            background: #f8f9fa;
        }
        .context-menu-item.danger {
            color: #dc3545;
        }
        .context-menu-item.danger:hover {
            background: #fff5f5;
        }
        .file-name {
            cursor: context-menu;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header-section">
            <h1>🔍 PDC Custom Code Browser</h1>
            <div class="search-container">
                <input type="text" id="search-input" class="search-input" placeholder="Search files... (fuzzy search, press Enter or wait 300ms)" autocomplete="off">
            </div>
        </div>

        <div class="controls-bar">
            <div class="env-filters">
                <button class="env-filter-btn active" data-env="all">All Environments</button>
                <button class="env-filter-btn" data-env="prod">Production</button>
                <button class="env-filter-btn" data-env="staging">Staging</button>
            </div>
            <div id="stats" class="stats">Loading files...</div>
        </div>

        <div class="controls-bar">
            <div class="folder-filters" id="folder-filters">
                <button class="folder-filter-btn active" data-folder="all">All Folders</button>
            </div>
        </div>

        <div id="file-list" class="file-list">
            <div class="loading">Loading files...</div>
        </div>

        <div class="nav-links">
            <a href="/upload">📤 Upload Files</a>
            <a href="${origin}">🏠 Home</a>
        </div>
    </div>

    <div id="context-menu" class="context-menu">
        <div class="context-menu-item danger" onclick="contextMenuDelete()">🗑️ Delete File</div>
    </div>

    <script>
        let searchTimeout;
        const searchInput = document.getElementById('search-input');
        const fileList = document.getElementById('file-list');
        const stats = document.getElementById('stats');
        const password = '${password}';
        let currentEnv = 'all';
        let currentFolder = 'all';
        let contextMenuFilePath = null;
        const contextMenu = document.getElementById('context-menu');

        function getFileEnvironment(filename) {
            if (filename.startsWith('code/staging/')) {
                return 'staging';
            }
            return 'prod';
        }

        function getFileFolder(filename) {
            // Extract folder from path like code/staging/js/app.js -> js or code/prod/js/app.js -> js
            let pathAfterEnv = filename;
            if (filename.startsWith('code/staging/')) {
                pathAfterEnv = filename.substring('code/staging/'.length);
            } else if (filename.startsWith('code/prod/')) {
                pathAfterEnv = filename.substring('code/prod/'.length);
            } else if (filename.startsWith('code/')) {
                pathAfterEnv = filename.substring('code/'.length);
            }
            const parts = pathAfterEnv.split('/');
            return parts.length > 1 && parts[0] ? parts[0] : '';
        }

        function filterByFolder(folder) {
            currentFolder = folder;
            // Update folder filter button active state
            document.querySelectorAll('.folder-filter-btn').forEach(btn => btn.classList.remove('active'));
            document.querySelector(\`.folder-filter-btn[data-folder="\${folder}"]\`)?.classList.add('active');
            loadFiles(searchInput.value, currentEnv, currentFolder);
        }

        async function loadFiles(search = '', env = currentEnv, folder = currentFolder) {
            try {
                fileList.innerHTML = '<div class="loading">Loading files...</div>';

                const response = await fetch(\`/api/files?password=\${encodeURIComponent(password)}&search=\${encodeURIComponent(search)}&env=\${encodeURIComponent(env)}&folder=\${encodeURIComponent(folder)}\`);
                const data = await response.json();

                if (data.error) {
                    fileList.innerHTML = '<div class="no-files">Error loading files</div>';
                    stats.textContent = 'Error loading files';
                    return;
                }

                const files = data.files || [];
                const folders = data.folders || [];

                // Update folder filter buttons dynamically
                const folderFiltersContainer = document.getElementById('folder-filters');
                folderFiltersContainer.innerHTML = '<button class="folder-filter-btn' + (folder === 'all' ? ' active' : '') + '" data-folder="all">All Folders</button>';
                folders.forEach(f => {
                    folderFiltersContainer.innerHTML += \`<button class="folder-filter-btn\${folder === f ? ' active' : ''}" data-folder="\${f}">\${f}</button>\`;
                });

                // Add click handlers to folder filter buttons
                document.querySelectorAll('.folder-filter-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        filterByFolder(btn.dataset.folder);
                    });
                });

                if (files.length === 0) {
                    fileList.innerHTML = '<div class="no-files">No files found</div>';
                    const folderContext = folder !== 'all' ? \` in "\${folder}"\` : '';
                    const envContext = env !== 'all' ? \` (\${env})\` : '';
                    stats.textContent = search ? \`No files match "\${search}"\${folderContext}\${envContext}\` : \`No files in CDN\${folderContext}\${envContext}\`;
                    return;
                }

                const folderContext = folder !== 'all' ? \` in "\${folder}"\` : '';
                const envContext = env !== 'all' ? \` (\${env})\` : '';
                stats.textContent = \`Found \${files.length} file\${files.length === 1 ? '' : 's'}\${search ? \` matching "\${search}"\` : ''}\${folderContext}\${envContext}\`;

                fileList.innerHTML = files.map(url => {
                    const filename = url.split('/').pop();
                    // Remove the origin from the URL to get the path
                    const originPrefix = window.location.origin + '/';
                    const fullPath = url.startsWith(originPrefix) ? url.substring(originPrefix.length) : url;
                    const env = getFileEnvironment(fullPath);
                    const envBadge = env === 'staging' ? '<span class="env-badge staging">staging</span>' : '<span class="env-badge prod">prod</span>';
                    
                    // Get folder and create folder badge
                    const folderName = getFileFolder(fullPath);
                    const folderBadge = folderName ? \`<span class="folder-badge" onclick="filterByFolder('\${folderName}')">\${folderName}</span>\` : '';

                    // Check if file is HTML
                    const extension = filename.split('.').pop().toLowerCase();
                    const isHtml = extension === 'html' || extension === 'htm';

                    if (isHtml) {
                        return \`
                            <div class="file-item">
                                <div class="file-name" title="\${filename}" data-filepath="\${fullPath}" oncontextmenu="showContextMenu(event, '\${fullPath}')" onclick="copyHtmlContent('\${fullPath}', this)">\${envBadge}\${folderBadge}\${filename}</div>
				<div class="file-url" title="\${url}" onclick="copyHtmlContent('\${fullPath}', this)">\${url}</div>
								<button class="copy-btn" onclick="copyHtmlContent('\${fullPath}', this)">📄 Copy Content</button>
							</div>
						\`;
					} else {
						return \`
							<div class="file-item">
								<div class="file-name" title="\${filename}" data-filepath="\${fullPath}" oncontextmenu="showContextMenu(event, '\${fullPath}')" onclick="copyToClipboard('\${url}', this)">\${envBadge}\${folderBadge}\${filename}</div>
								<div class="file-url" title="\${url}" onclick="copyToClipboard('\${url}', this)">\${url}</div>
								<button class="copy-btn" onclick="copyToClipboard('\${url}', this)">📋 Copy</button>
                            </div>
                        \`;
                    }
                }).join('');

            } catch (error) {
                console.error('Error loading files:', error);
                fileList.innerHTML = '<div class="no-files">Error loading files</div>';
                stats.textContent = 'Error loading files';
            }
        }

        function copyToClipboard(text, element) {
            navigator.clipboard.writeText(text).then(() => {
                // Handle different element types
                if (element.tagName === 'BUTTON') {
                    const originalText = element.textContent;
                    element.textContent = '✅ Copied!';
                    element.classList.add('copied');

                    setTimeout(() => {
                        element.textContent = originalText;
                        element.classList.remove('copied');
                    }, 2000);
                } else {
                    // For div elements (file URLs), add a temporary highlight
                    element.classList.add('copied');
                    setTimeout(() => {
                        element.classList.remove('copied');
                    }, 2000);
                }
            }).catch(err => {
                console.error('Failed to copy:', err);
                // Fallback for older browsers
                const textArea = document.createElement('textarea');
                textArea.value = text;
                document.body.appendChild(textArea);
                textArea.select();
                document.execCommand('copy');
                document.body.removeChild(textArea);

                // Handle different element types for fallback too
                if (element.tagName === 'BUTTON') {
                    const originalText = element.textContent;
                    element.textContent = '✅ Copied!';
                    element.classList.add('copied');

                    setTimeout(() => {
                        element.textContent = originalText;
                        element.classList.remove('copied');
                    }, 2000);
                } else {
                    // For div elements (file URLs), add a temporary highlight
                    element.classList.add('copied');
                    setTimeout(() => {
                        element.classList.remove('copied');
                    }, 2000);
                }
            });
        }

		async function copyHtmlContent(filename, element) {
			try {
				// Show loading state
				const originalText = element.textContent;
				element.textContent = '⏳ Loading...';
				element.disabled = true;

				// Fetch HTML content
				const response = await fetch(\`/api/file-content?password=\${encodeURIComponent(password)}&file=\${encodeURIComponent(filename)}\`);
				const data = await response.json();

				if (data.error) {
					throw new Error(data.error);
				}

				// Copy content to clipboard
				await navigator.clipboard.writeText(data.content);

				// Show success state
				element.textContent = '✅ Copied!';
				element.classList.add('copied');

				setTimeout(() => {
					element.textContent = originalText;
					element.classList.remove('copied');
					element.disabled = false;
				}, 2000);

			} catch (error) {
				console.error('Failed to copy HTML content:', error);

				// Show error state
				const originalText = element.textContent;
				element.textContent = '❌ Error';
				element.classList.add('copied'); // Use same styling for error

				setTimeout(() => {
					element.textContent = originalText;
					element.classList.remove('copied');
					element.disabled = false;
				}, 2000);
			}
		}

        function showContextMenu(event, filepath) {
            event.preventDefault();
            contextMenuFilePath = filepath;
            
            const menu = document.getElementById('context-menu');
            menu.classList.add('show');
            
            // Position the menu at cursor
            menu.style.left = event.pageX + 'px';
            menu.style.top = event.pageY + 'px';
        }

        // Close context menu when clicking elsewhere
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.context-menu')) {
                contextMenu.classList.remove('show');
                contextMenuFilePath = null;
            }
        });

        // Close context menu on scroll
        fileList.addEventListener('scroll', () => {
            contextMenu.classList.remove('show');
            contextMenuFilePath = null;
        });

        let deleteConfirmInProgress = false;
        let deleteConfirmTimeout = null;

        async function contextMenuDelete() {
            if (!contextMenuFilePath) return;
            
            const filepath = contextMenuFilePath;
            contextMenu.classList.remove('show');
            contextMenuFilePath = null;

            try {
                // First click: Ask for confirmation
                if (!deleteConfirmInProgress) {
                    deleteConfirmInProgress = true;
                    
                    // Show confirmation prompt
                    const confirmMsg = document.createElement('div');
                    confirmMsg.style.cssText = 'position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: #fff3cd; border: 2px solid #ffc107; padding: 15px 20px; border-radius: 8px; z-index: 2000; box-shadow: 0 4px 12px rgba(0,0,0,0.15); font-weight: 500;';
                    confirmMsg.innerHTML = '⚠️ Right-click the file again to confirm deletion';
                    document.body.appendChild(confirmMsg);

                    // Reset after 4 seconds if not confirmed
                    deleteConfirmTimeout = setTimeout(() => {
                        deleteConfirmInProgress = false;
                        document.body.removeChild(confirmMsg);
                    }, 4000);

                    return;
                }

                // Clear the timeout
                if (deleteConfirmTimeout) {
                    clearTimeout(deleteConfirmTimeout);
                    deleteConfirmTimeout = null;
                }

                deleteConfirmInProgress = false;

                // Second click: Actually delete
                const loadingMsg = document.createElement('div');
                loadingMsg.style.cssText = 'position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: white; border: 2px solid #007bff; padding: 15px 20px; border-radius: 8px; z-index: 2000; box-shadow: 0 4px 12px rgba(0,0,0,0.15); font-weight: 500;';
                loadingMsg.innerHTML = '⏳ Deleting file...';
                document.body.appendChild(loadingMsg);

                // Call delete API
                const response = await fetch(\`/api/delete-file?password=\${encodeURIComponent(password)}&file=\${encodeURIComponent(filepath)}\`, {
                    method: 'DELETE',
                });

                const data = await response.json();

                if (data.error) {
                    throw new Error(data.error);
                }

                // Show success
                loadingMsg.style.background = '#d4edda';
                loadingMsg.style.borderColor = '#28a745';
                loadingMsg.innerHTML = '✅ File deleted successfully!';
                
                setTimeout(() => {
                    document.body.removeChild(loadingMsg);
                    loadFiles(searchInput.value, currentEnv);
                }, 1500);

            } catch (error) {
                console.error('Failed to delete file:', error);
                
                deleteConfirmInProgress = false;

                // Show error
                const errorMsg = document.createElement('div');
                errorMsg.style.cssText = 'position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: #f8d7da; border: 2px solid #dc3545; padding: 15px 20px; border-radius: 8px; z-index: 2000; box-shadow: 0 4px 12px rgba(0,0,0,0.15); font-weight: 500;';
                errorMsg.innerHTML = '❌ Failed to delete file';
                document.body.appendChild(errorMsg);

                setTimeout(() => {
                    document.body.removeChild(errorMsg);
                }, 3000);
            }
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

        // Handle environment filter buttons
        document.querySelectorAll('.env-filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                // Update active button
                document.querySelectorAll('.env-filter-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                // Update current environment and reload files
                currentEnv = btn.dataset.env;
                loadFiles(searchInput.value, currentEnv, currentFolder);
            });
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

			// Handle delete file API route
			if (url.pathname === '/api/delete-file') {
				if (request.method === 'DELETE') {
					try {
						// Validate password for API access
						const password = url.searchParams.get('password');
						if (!env.UPLOAD_PASSWORD || password !== env.UPLOAD_PASSWORD) {
							return new Response(JSON.stringify({ error: 'Unauthorized' }), {
								status: 401,
								headers: { 'Content-Type': 'application/json' },
							});
						}

						const filename = url.searchParams.get('file');
						if (!filename) {
							return new Response(JSON.stringify({ error: 'File parameter required' }), {
								status: 400,
								headers: { 'Content-Type': 'application/json' },
							});
						}

						// Security check: Only allow deletion of files within the 'code/' directory
						if (!filename.startsWith('code/')) {
							return new Response(JSON.stringify({ error: 'Can only delete files in code/ directory' }), {
								status: 403,
								headers: { 'Content-Type': 'application/json' },
							});
						}

						// Check if file exists
						const object = await env.CDN_BUCKET.get(filename);
						if (!object) {
							return new Response(JSON.stringify({ error: 'File not found' }), {
								status: 404,
								headers: { 'Content-Type': 'application/json' },
							});
						}

						// Delete the file from R2
						await env.CDN_BUCKET.delete(filename);

						return new Response(JSON.stringify({ success: true, message: 'File deleted successfully' }), {
							headers: {
								'Content-Type': 'application/json',
								'Cache-Control': 'no-cache',
							},
						});
					} catch (error) {
						console.error('Delete file API error:', error);
						return new Response(JSON.stringify({ error: 'Failed to delete file' }), {
							status: 500,
							headers: { 'Content-Type': 'application/json' },
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
						const envFilter = url.searchParams.get('env') || 'all';
						const folderFilter = url.searchParams.get('folder') || 'all';
						const { files, folders } = await getFilesList(env.CDN_BUCKET, search, envFilter, folderFilter);
						const cdnUrls = files.map((filename) => `${url.origin}/${filename}`);

						return new Response(JSON.stringify({ files: cdnUrls, folders }), {
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

			// Handle file content API route for fetching HTML content
			if (url.pathname === '/api/file-content') {
				if (request.method === 'GET') {
					try {
						// Validate password for API access
						const password = url.searchParams.get('password');
						if (!env.UPLOAD_PASSWORD || password !== env.UPLOAD_PASSWORD) {
							return new Response(JSON.stringify({ error: 'Unauthorized' }), {
								status: 401,
								headers: { 'Content-Type': 'application/json' },
							});
						}

						const filename = url.searchParams.get('file');
						if (!filename) {
							return new Response(JSON.stringify({ error: 'File parameter required' }), {
								status: 400,
								headers: { 'Content-Type': 'application/json' },
							});
						}

						// Only allow HTML files for content fetching
						const extension = filename.split('.').pop().toLowerCase();
						if (extension !== 'html' && extension !== 'htm') {
							return new Response(JSON.stringify({ error: 'Only HTML files are supported' }), {
								status: 400,
								headers: { 'Content-Type': 'application/json' },
							});
						}

						// Get the file from R2
						const object = await env.CDN_BUCKET.get(filename);
						if (!object) {
							return new Response(JSON.stringify({ error: 'File not found' }), {
								status: 404,
								headers: { 'Content-Type': 'application/json' },
							});
						}

						// Read the content as text
						const content = await object.text();

						return new Response(JSON.stringify({ content }), {
							headers: {
								'Content-Type': 'application/json',
								'Cache-Control': 'no-cache',
							},
						});
					} catch (error) {
						console.error('File content API error:', error);
						return new Response(JSON.stringify({ error: 'Failed to fetch file content' }), {
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

				// Check if the origin is allowed (including Webflow branches)
				if (!ALLOWED_ORIGINS.includes(requestOrigin) && !isValidWebflowBranch(requestOrigin)) {
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

			// Only set CORS headers for allowed origins (including Webflow branches)
			if (origin && (ALLOWED_ORIGINS.includes(origin) || isValidWebflowBranch(origin))) {
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
