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

// CDN URLs are mutable: browsers must revalidate them, while Cloudflare can
// retain an edge copy until the deployment workflow purges the updated URL.
export const BROWSER_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
export const CLOUDFLARE_CACHE_CONTROL = 'public, max-age=31536000';
// Contract with marketing-tools (CDN Files): deleted uploads move under TRASH_PREFIX, and a rename
// can leave an empty placeholder at the old key whose custom metadata names the new key.
export const TRASH_PREFIX = '_trash/';
export const REDIRECT_METADATA_KEY = 'cdn-redirect-to';
export const PROTECTED_PREFIXES = ['code/', 'analytics/', 'marketing-tools/', 'marketing/', 'careers/', TRASH_PREFIX];
const DEFAULT_CDN_PUBLIC_BASE = 'https://files.point.com';

// Upload, browse, and the code browser moved to the marketing-tools hub (Google sign-in, per-user
// permissions). Old links land there; every other path is file serving.
const MARKETING_TOOLS_BASE = 'https://marketing-tools.ops-1df.workers.dev';
export const ADMIN_REDIRECTS = {
	'/upload': '/tools/cdn-files',
	'/browse': '/tools/cdn-files',
	'/code': '/tools/code-browser',
};

// File types that should be previewed in browser
const PREVIEW_TYPES = new Set(['pdf', 'html', 'htm', 'jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'mp4']);

// Allowed origins for CORS requests
const ALLOWED_ORIGINS = [
	'https://www.point.dev',
	'https://point.com',
	'https://files.point.com',
	'https://scorecredit.com',
	'https://scorecredit.webflow.io',
	'https://canvas.webflow.com',
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

// Font assets must be publicly usable by external rendering services such as Lob.
// Keep this scoped to the dedicated staging/prod font directories so other code
// assets retain the existing origin allowlist.
export function isPublicFontAsset(path) {
	return /^code\/(?:staging|prod)\/fonts\//.test(path);
}

// The new key a rename placeholder points at, or null for an ordinary object. Protected folders never
// redirect, so a stray metadata value cannot send a point.com script somewhere else.
export function redirectTargetKey(path, object) {
	const target = object?.customMetadata?.[REDIRECT_METADATA_KEY];
	if (!target || PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix)) || !isReplaceableUploadKey(target)) {
		return null;
	}
	return target;
}

export function isReplaceableUploadKey(key) {
	if (typeof key !== 'string' || key.length === 0 || key.length > 1024) {
		return false;
	}
	if (key.includes('\0') || key.includes('\\') || key.startsWith('/') || key.includes('//')) {
		return false;
	}
	const parts = key.split('/');
	if (parts.some((part) => part === '' || part === '.' || part === '..')) {
		return false;
	}
	return !PROTECTED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function publicCdnBase(env, requestUrl) {
	const configured = typeof env?.CDN_PUBLIC_BASE === 'string' ? env.CDN_PUBLIC_BASE.trim() : '';
	return (configured || new URL(requestUrl).origin || DEFAULT_CDN_PUBLIC_BASE).replace(/\/$/, '');
}

export default {
	async fetch(request, env) {
		try {
			const url = new URL(request.url);
			const path = url.pathname.slice(1); // Remove leading slash

			const hubPath = ADMIN_REDIRECTS[url.pathname];
			if (hubPath) {
				return new Response(null, {
					status: 302,
					headers: { Location: `${MARKETING_TOOLS_BASE}${hubPath}`, 'Cache-Control': 'no-store' },
				});
			}

			const forceDownload = url.searchParams.get('download') === 'true';

			// Redirect root path to point.com
			if (!path) {
				return Response.redirect('https://point.com', 302);
			}

			// Trashed uploads are never served; they read as missing.
			if (path.startsWith(TRASH_PREFIX)) {
				return Response.redirect('https://point.com', 302);
			}

			// Get the file from R2
			// url.pathname is decoded by the URL constructor (%20 -> space).
			// We also try decodeURIComponent in case of double-encoding, and the
			// raw request URI path in case Cloudflare passes it through encoded.
			let object = await env.CDN_BUCKET.get(path);
			if (!object) {
				// Extract the raw (still-percent-encoded) path directly from request.url string
				// by splitting on the host, avoiding the URL constructor's auto-decode.
				const rawUrlPath = request.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0].slice(1);
				if (rawUrlPath !== path) {
					object = await env.CDN_BUCKET.get(rawUrlPath);
				}
			}

			if (!object) {
				// Redirect 404s to point.com
				return Response.redirect('https://point.com', 302);
			}

			// Rename placeholder: read from the object already fetched, so ordinary files cost nothing extra.
			// no-store keeps the redirect out of every cache, so removing it takes effect at once.
			const redirectKey = redirectTargetKey(path, object);
			if (redirectKey) {
				const target = redirectKey.split('/').map(encodeURIComponent).join('/');
				return new Response(null, {
					status: 302,
					headers: {
						Location: `${publicCdnBase(env, request.url)}/${target}${url.search}`,
						'Cache-Control': 'no-store',
						'Access-Control-Allow-Origin': '*',
					},
				});
			}

			const origin = request.headers.get('Origin');

			// CORS: code/ files are restricted to allowed origins only.
			// Font directory assets and all non-code files are public to any origin.
			const isCodeFile = path.startsWith('code/');
			const isPublicFontFile = isPublicFontAsset(path);
			if (isCodeFile && !isPublicFontFile) {
				const referer = request.headers.get('Referer');
				const isCrossOriginRequest = origin || referer;
				if (isCrossOriginRequest) {
					const requestOrigin = origin || (referer ? new URL(referer).origin : null);
					if (!ALLOWED_ORIGINS.includes(requestOrigin) && !isValidWebflowBranch(requestOrigin)) {
						return new Response('Forbidden', {
							status: 403,
							headers: { 'Content-Type': 'text/plain' },
						});
					}
				}
			}

			// Determine content type based on file extension
			const extension = path.split('.').pop().toLowerCase();
			const contentType = CONTENT_TYPES[extension] || 'application/octet-stream';

			// Prepare headers with caching
			const headers = new Headers({
				'Content-Type': contentType,
				'Cache-Control': BROWSER_CACHE_CONTROL,
				'Cloudflare-CDN-Cache-Control': CLOUDFLARE_CACHE_CONTROL,
				ETag: object.httpEtag,
				'Last-Modified': object.uploaded.toUTCString(),
			});

			// Set CORS headers based on file type:
			// - font directory and non-code files: open to any origin
			// - all other code/ files: only allowed origins get a reflected header
			if (isCodeFile && !isPublicFontFile) {
				if (origin && (ALLOWED_ORIGINS.includes(origin) || isValidWebflowBranch(origin))) {
					headers.set('Access-Control-Allow-Origin', origin);
					headers.set('Vary', 'Origin');
				}
			} else {
				headers.set('Access-Control-Allow-Origin', '*');
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
