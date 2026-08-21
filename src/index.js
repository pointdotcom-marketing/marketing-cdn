import uploadHtml from './ui/upload.html';
import successHtml from './ui/success.html';
import browseFilesHtml from './ui/browse-files.html';
import passwordHtml from './ui/password.html';
import codeBrowserHtml from './ui/code-browser.html';

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
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const PROTECTED_PREFIXES = ['code/', 'analytics/', 'marketing-tools/', 'marketing/', 'careers/'];
const DEFAULT_CDN_PUBLIC_BASE = 'https://files.point.com';

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
	'https://canvas.webflow.com',
];

const AUTH_SESSION_SECONDS = 24 * 60 * 60;
const AUTH_COOKIE_NAMES = {
	browse: 'cdn_browse_auth',
	code: 'cdn_code_auth',
};
const textEncoder = new TextEncoder();

async function importHmacKey(secret, usages) {
	return crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

export async function verifyPassword(candidate, expected) {
	if (typeof candidate !== 'string' || typeof expected !== 'string' || expected.length === 0) {
		return false;
	}

	const challenge = textEncoder.encode('marketing-cdn-password-verification');
	const expectedKey = await importHmacKey(expected, ['sign']);
	const candidateKey = await importHmacKey(candidate, ['verify']);
	const signature = await crypto.subtle.sign('HMAC', expectedKey, challenge);
	return crypto.subtle.verify('HMAC', candidateKey, signature, challenge);
}

function bytesToBase64Url(bytes) {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value) {
	try {
		const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
		return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
	} catch {
		return null;
	}
}

async function createAuthToken(scope, secret, now = Date.now()) {
	const expiresAt = Math.floor(now / 1000) + AUTH_SESSION_SECONDS;
	const payload = `${scope}:${expiresAt}`;
	const key = await importHmacKey(secret, ['sign']);
	const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(payload));
	return `${expiresAt}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifyAuthToken(token, scope, secret, now = Date.now()) {
	if (typeof token !== 'string' || typeof secret !== 'string' || secret.length === 0) {
		return false;
	}

	const separatorIndex = token.indexOf('.');
	if (separatorIndex <= 0) {
		return false;
	}

	const expiresAtString = token.slice(0, separatorIndex);
	const expiresAt = Number(expiresAtString);
	const signature = base64UrlToBytes(token.slice(separatorIndex + 1));
	if (!Number.isInteger(expiresAt) || expiresAt <= Math.floor(now / 1000) || !signature) {
		return false;
	}

	const key = await importHmacKey(secret, ['verify']);
	return crypto.subtle.verify('HMAC', key, signature, textEncoder.encode(`${scope}:${expiresAtString}`));
}

function getCookie(request, name) {
	const cookieHeader = request.headers.get('Cookie');
	if (!cookieHeader) {
		return null;
	}

	for (const cookie of cookieHeader.split(';')) {
		const [cookieName, ...valueParts] = cookie.trim().split('=');
		if (cookieName === name) {
			return valueParts.join('=');
		}
	}
	return null;
}

async function isAuthenticated(request, scope, secret) {
	return verifyAuthToken(getCookie(request, AUTH_COOKIE_NAMES[scope]), scope, secret);
}

async function getAuthCookie(scope, secret) {
	const token = await createAuthToken(scope, secret);
	return `${AUTH_COOKIE_NAMES[scope]}=${token}; Path=/; Max-Age=${AUTH_SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function secureHtmlHeaders(additionalHeaders = {}) {
	return {
		'Content-Type': 'text/html',
		'Cache-Control': 'no-store',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
		...additionalHeaders,
	};
}

function unauthorizedJsonResponse() {
	return new Response(JSON.stringify({ error: 'Unauthorized' }), {
		status: 401,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
		},
	});
}

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

// Generate unique filename by adding -1, -2, etc. if file exists
async function getUniqueFilename(bucket, originalName) {
	// Replace spaces with dashes for cleaner URLs
	originalName = originalName.replace(/ /g, '-');

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

export function fileExtension(name) {
	const lastDot = name.lastIndexOf('.');
	if (lastDot <= 0) {
		return '';
	}
	return name.slice(lastDot + 1).toLowerCase();
}

export function fileExtensionsMatch(existingKey, uploadName) {
	return fileExtension(existingKey) === fileExtension(uploadName);
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

export function purgeUrlsForCdnKey(publicBase, key) {
	const encodedKey = key.split('/').map(encodeURIComponent).join('/');
	const url = `${publicBase.replace(/\/$/, '')}/${encodedKey}`;
	return [url, `${url}?download=true`];
}

export async function purgeCloudflareFiles(env, urls, fetchImpl = fetch) {
	const zoneId = typeof env?.CF_ZONE_ID === 'string' ? env.CF_ZONE_ID.trim() : '';
	const token = typeof env?.CF_API_TOKEN === 'string' ? env.CF_API_TOKEN.trim() : '';
	if (!zoneId || !token) {
		console.error('Cache purge skipped: CF_ZONE_ID or CF_API_TOKEN is not configured');
		return { ok: false, skipped: true };
	}

	try {
		const response = await fetchImpl(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ files: urls }),
		});
		const body = await response.json().catch(() => null);
		const ok = response.ok && body?.success === true;
		if (!ok) {
			console.error('Cache purge failed', { status: response.status, errors: body?.errors });
		}
		return { ok, skipped: false };
	} catch (error) {
		console.error('Cache purge failed', error);
		return { ok: false, skipped: false };
	}
}

function extensionMismatchMessage(key) {
	const extension = fileExtension(key);
	return extension
		? `Replacement must keep the .${extension} extension so the URL still works`
		: 'Replacement must also have no file extension so the URL still works';
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
		let files = objects.objects.map((obj) => ({ key: obj.key, uploaded: obj.uploaded }));

		// Only include files within the 'code/' directory and its subdirectories
		files = files.filter((file) => file.key.startsWith('code/'));

		// Filter by environment (staging/prod/all)
		if (env === 'staging') {
			files = files.filter((file) => file.key.startsWith('code/staging/'));
		} else if (env === 'prod') {
			files = files.filter((file) => file.key.startsWith('code/') && !file.key.startsWith('code/staging/'));
		}

		// Extract unique folders from file paths (e.g., code/staging/js/app.js -> js or code/prod/js/app.js -> js)
		const foldersSet = new Set();
		files.forEach((file) => {
			// Remove code/staging/ or code/prod/ prefix
			let pathAfterEnv = file.key;
			if (file.key.startsWith('code/staging/')) {
				pathAfterEnv = file.key.substring('code/staging/'.length);
			} else if (file.key.startsWith('code/prod/')) {
				pathAfterEnv = file.key.substring('code/prod/'.length);
			} else if (file.key.startsWith('code/')) {
				pathAfterEnv = file.key.substring('code/'.length);
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
			files = files.filter((file) => {
				let pathAfterEnv = file.key;
				if (file.key.startsWith('code/staging/')) {
					pathAfterEnv = file.key.substring('code/staging/'.length);
				} else if (file.key.startsWith('code/prod/')) {
					pathAfterEnv = file.key.substring('code/prod/'.length);
				} else if (file.key.startsWith('code/')) {
					pathAfterEnv = file.key.substring('code/'.length);
				}
				const folderName = pathAfterEnv.split('/')[0];
				return folderName === folder;
			});
		}

		// Filter by search term if provided (fuzzy search)
		if (search) {
			files = files.filter((file) => {
				const score = fuzzyScore(file.key, search);
				return score > 0.2; // Minimum threshold for fuzzy matches
			});
		}

		// Sort alphabetically by key
		files.sort((a, b) => a.key.localeCompare(b.key));

		return { files, folders };
	} catch (error) {
		console.error('Error listing files:', error);
		return { files: [], folders: [] };
	}
}

// List all files NOT in the code/ directory (for the simple /browse view)
async function getFilesListSimple(bucket, search = '') {
	try {
		const objects = await bucket.list();
		let files = objects.objects.map((obj) => ({ key: obj.key, uploaded: obj.uploaded }));

		// Hide code, leftover analytics, and tool namespaces (PDF/logo galleries, careers embeds).
		files = files.filter((file) => !PROTECTED_PREFIXES.some((prefix) => file.key.startsWith(prefix)));

		// Filter by search term if provided (fuzzy search)
		if (search) {
			files = files.filter((file) => {
				const score = fuzzyScore(file.key, search);
				return score > 0.2;
			});
		}

		// Sort newest first
		files.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));

		return { files };
	} catch (error) {
		console.error('Error listing files:', error);
		return { files: [] };
	}
}

export function escapeHtml(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function fillTemplate(template, replacements) {
	let result = template;
	for (const [token, value] of Object.entries(replacements)) {
		result = result.split(token).join(value);
	}
	return result;
}

const UPLOAD_FORM_HTML = uploadHtml;

function getSuccessHTML(filename, cdnUrl) {
	return fillTemplate(successHtml, {
		__FILENAME__: escapeHtml(filename),
		__CDN_URL__: escapeHtml(cdnUrl),
	});
}

function getBrowseFilesHTML() {
	return browseFilesHtml;
}

function getBrowserPasswordHTML(
	browserName,
	errorMessage = '',
	submitLabel = 'Access File Browser',
	description = 'Enter the password to access the file browser and search CDN files.'
) {
	const errorBlock = errorMessage
		? `<div class="error">${escapeHtml(errorMessage)}</div>`
		: '';
	return fillTemplate(passwordHtml, {
		__BROWSER_NAME__: escapeHtml(browserName),
		__ERROR_BLOCK__: errorBlock,
		__DESCRIPTION__: escapeHtml(description),
		__SUBMIT_LABEL__: escapeHtml(submitLabel),
	});
}

function getBrowseHTML() {
	return codeBrowserHtml;
}


export default {
	async fetch(request, env) {
		try {
			// Parse the URL and get the pathname
			const url = new URL(request.url);
			const path = url.pathname.slice(1); // Remove leading slash

			// Handle browse route - password-protected file listing
			if (url.pathname === '/browse') {
				if (request.method === 'GET') {
					if (!env.UPLOAD_PASSWORD || !(await isAuthenticated(request, 'browse', env.UPLOAD_PASSWORD))) {
						return new Response(getBrowserPasswordHTML('Files Browser'), {
							headers: secureHtmlHeaders(),
						});
					}

					return new Response(getBrowseFilesHTML(url.origin), {
						headers: secureHtmlHeaders(),
					});
				}

				if (request.method === 'POST') {
					try {
						const formData = await request.formData();
						const password = formData.get('password');
						if (!(await verifyPassword(password, env.UPLOAD_PASSWORD))) {
							return new Response(getBrowserPasswordHTML('Files Browser', 'Invalid password. Please try again.'), {
								status: 401,
								headers: secureHtmlHeaders(),
							});
						}

						return new Response(null, {
							status: 303,
							headers: {
								Location: '/browse',
								'Set-Cookie': await getAuthCookie('browse', env.UPLOAD_PASSWORD),
								'Cache-Control': 'no-store',
							},
						});
					} catch (error) {
						console.error('Browse auth error:', error);
						return new Response(getBrowserPasswordHTML('Files Browser', 'An error occurred. Please try again.'), {
							status: 500,
							headers: secureHtmlHeaders(),
						});
					}
				}

				return new Response('Method Not Allowed', { status: 405 });
			}

			// Handle code browser route
			if (url.pathname === '/code') {
				if (request.method === 'GET') {
					if (!env.CODE_PASSWORD || !(await isAuthenticated(request, 'code', env.CODE_PASSWORD))) {
						return new Response(getBrowserPasswordHTML('PDC Custom Code Browser'), {
							headers: secureHtmlHeaders(),
						});
					}

					return new Response(getBrowseHTML(url.origin), {
						headers: secureHtmlHeaders(),
					});
				}

				if (request.method === 'POST') {
					try {
						const formData = await request.formData();
						const password = formData.get('password');

						if (!(await verifyPassword(password, env.CODE_PASSWORD))) {
							return new Response(getBrowserPasswordHTML('PDC Custom Code Browser', 'Invalid password. Please try again.'), {
								status: 401,
								headers: secureHtmlHeaders(),
							});
						}

						return new Response(null, {
							status: 303,
							headers: {
								Location: '/code',
								'Set-Cookie': await getAuthCookie('code', env.CODE_PASSWORD),
								'Cache-Control': 'no-store',
							},
						});
					} catch (error) {
						console.error('Code browser auth error:', error);
						return new Response(getBrowserPasswordHTML('PDC Custom Code Browser', 'An error occurred. Please try again.'), {
							status: 500,
							headers: secureHtmlHeaders(),
						});
					}
				}

				return new Response('Method Not Allowed', { status: 405 });
			}

			// Handle browse files API route
			if (url.pathname === '/api/browse-files') {
				if (request.method === 'GET') {
					try {
						if (!env.UPLOAD_PASSWORD || !(await isAuthenticated(request, 'browse', env.UPLOAD_PASSWORD))) {
							return unauthorizedJsonResponse();
						}

						const search = url.searchParams.get('search') || '';
						const { files } = await getFilesListSimple(env.CDN_BUCKET, search);
						const fileData = files.map(({ key, uploaded }) => ({
							key,
							url: encodeURI(`${url.origin}/${key}`),
							lastModified: uploaded,
							replaceable: isReplaceableUploadKey(key),
						}));
						return new Response(JSON.stringify({ files: fileData }), {
							headers: {
								'Content-Type': 'application/json',
								'Cache-Control': 'no-cache',
							},
						});
					} catch (error) {
						console.error('Browse files API error:', error);
						return new Response(JSON.stringify({ error: 'Failed to fetch files' }), {
							status: 500,
							headers: { 'Content-Type': 'application/json' },
						});
					}
				}
				return new Response('Method Not Allowed', { status: 405 });
			}

			// Handle replace file API route (uploaded assets only; keeps the existing CDN key)
			if (url.pathname === '/api/replace-file') {
				if (request.method === 'POST') {
					try {
						if (!env.UPLOAD_PASSWORD || !(await isAuthenticated(request, 'browse', env.UPLOAD_PASSWORD))) {
							return unauthorizedJsonResponse();
						}

						const formData = await request.formData();
						const file = formData.get('file');
						const key = String(formData.get('key') ?? '').trim();

						if (!file || typeof file === 'string' || file.size === 0) {
							return new Response(JSON.stringify({ error: 'Please select a file to upload' }), {
								status: 400,
								headers: { 'Content-Type': 'application/json' },
							});
						}
						if (file.size > MAX_UPLOAD_BYTES) {
							return new Response(JSON.stringify({ error: 'File exceeds the 100 MB limit' }), {
								status: 413,
								headers: { 'Content-Type': 'application/json' },
							});
						}
						if (!isReplaceableUploadKey(key)) {
							return new Response(JSON.stringify({ error: 'That file cannot be replaced from this page' }), {
								status: 403,
								headers: { 'Content-Type': 'application/json' },
							});
						}
						if (!fileExtensionsMatch(key, file.name)) {
							return new Response(JSON.stringify({ error: extensionMismatchMessage(key) }), {
								status: 400,
								headers: { 'Content-Type': 'application/json' },
							});
						}

						const existing = await env.CDN_BUCKET.head(key);
						if (!existing) {
							return new Response(JSON.stringify({ error: 'File not found. Upload it as a new file instead.' }), {
								status: 404,
								headers: { 'Content-Type': 'application/json' },
							});
						}

						await env.CDN_BUCKET.put(key, file.stream(), {
							httpMetadata: {
								contentType: file.type || existing.httpMetadata?.contentType || 'application/octet-stream',
							},
						});

						const cdnUrl = `${publicCdnBase(env, request.url)}/${key.split('/').map(encodeURIComponent).join('/')}`;
						const purge = await purgeCloudflareFiles(env, purgeUrlsForCdnKey(publicCdnBase(env, request.url), key));

						return new Response(
							JSON.stringify({
								success: true,
								key,
								url: cdnUrl,
								cachePurged: purge.ok,
								cacheSkipped: purge.skipped,
							}),
							{
								headers: {
									'Content-Type': 'application/json',
									'Cache-Control': 'no-store',
								},
							}
						);
					} catch (error) {
						console.error('Replace file API error:', error);
						return new Response(JSON.stringify({ error: 'Failed to replace file' }), {
							status: 500,
							headers: { 'Content-Type': 'application/json' },
						});
					}
				}

				return new Response('Method Not Allowed', { status: 405 });
			}

			// Handle delete file API route
			if (url.pathname === '/api/delete-file') {
				if (request.method === 'DELETE') {
					try {
						if (!env.CODE_PASSWORD || !(await isAuthenticated(request, 'code', env.CODE_PASSWORD))) {
							return unauthorizedJsonResponse();
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
						if (!env.CODE_PASSWORD || !(await isAuthenticated(request, 'code', env.CODE_PASSWORD))) {
							return unauthorizedJsonResponse();
						}

					const search = url.searchParams.get('search') || '';
					const envFilter = url.searchParams.get('env') || 'all';
					const folderFilter = url.searchParams.get('folder') || 'all';
					const { files, folders } = await getFilesList(env.CDN_BUCKET, search, envFilter, folderFilter);
					const fileData = files.map(({ key, uploaded }) => ({
						url: encodeURI(`${url.origin}/${key}`),
						lastModified: uploaded,
					}));

					return new Response(JSON.stringify({ files: fileData, folders }), {
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
						if (!env.CODE_PASSWORD || !(await isAuthenticated(request, 'code', env.CODE_PASSWORD))) {
							return unauthorizedJsonResponse();
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
					if (!env.UPLOAD_PASSWORD || !(await isAuthenticated(request, 'browse', env.UPLOAD_PASSWORD))) {
						return new Response(
							getBrowserPasswordHTML(
								'File Upload',
								'',
								'Access Upload Form',
								'Enter the upload password to access the upload form and file browser.'
							),
							{ headers: secureHtmlHeaders() }
						);
					}

					return new Response(UPLOAD_FORM_HTML, {
						headers: secureHtmlHeaders(),
					});
				}

				if (request.method === 'POST') {
					try {
						const authenticated = env.UPLOAD_PASSWORD && (await isAuthenticated(request, 'browse', env.UPLOAD_PASSWORD));
						if (!authenticated) {
							const contentType = request.headers.get('Content-Type') || '';
							if (!contentType.startsWith('application/x-www-form-urlencoded')) {
								return new Response(
									getBrowserPasswordHTML(
										'File Upload',
										'Please log in before uploading a file.',
										'Access Upload Form',
										'Enter the upload password to access the upload form and file browser.'
									),
									{
										status: 401,
										headers: secureHtmlHeaders(),
									}
								);
							}

							const loginFormData = await request.formData();
							const password = loginFormData.get('password');
							if (!(await verifyPassword(password, env.UPLOAD_PASSWORD))) {
								return new Response(
									getBrowserPasswordHTML(
										'File Upload',
										'Invalid password. Please try again.',
										'Access Upload Form',
										'Enter the upload password to access the upload form and file browser.'
									),
									{
										status: 401,
										headers: secureHtmlHeaders(),
									}
								);
							}

							return new Response(null, {
								status: 303,
								headers: {
									Location: '/upload',
									'Set-Cookie': await getAuthCookie('browse', env.UPLOAD_PASSWORD),
									'Cache-Control': 'no-store',
								},
							});
						}

						const formData = await request.formData();
						const file = formData.get('file');

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
							headers: secureHtmlHeaders({
								'Set-Cookie': await getAuthCookie('browse', env.UPLOAD_PASSWORD),
							}),
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
