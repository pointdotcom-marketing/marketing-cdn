import { describe, expect, test } from 'vitest';
import worker, {
	BROWSER_CACHE_CONTROL,
	CLOUDFLARE_CACHE_CONTROL,
	escapeHtml,
	fileExtensionsMatch,
	isPublicFontAsset,
	isReplaceableUploadKey,
	purgeCloudflareFiles,
	purgeUrlsForCdnKey,
	verifyPassword,
} from './index.js';
import codeBrowserHtml from './ui/code-browser.html';
import browseFilesHtml from './ui/browse-files.html';

const PASSWORDS = {
	CODE_PASSWORD: 'code-secret',
	UPLOAD_PASSWORD: 'upload-secret',
};

function authRequest(path, password) {
	return new Request(`https://files.point.com${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ password }),
	});
}

async function authenticatedCookie(path, password) {
	const loginResponse = await worker.fetch(authRequest(path, password), PASSWORDS);
	return loginResponse.headers.get('Set-Cookie').split(';')[0];
}

describe('CDN cache policy', () => {
	test('requires browser revalidation while retaining a long-lived Cloudflare copy', () => {
		expect(BROWSER_CACHE_CONTROL).toBe('public, max-age=0, must-revalidate');
		expect(CLOUDFLARE_CACHE_CONTROL).toBe('public, max-age=31536000');
	});
});

describe('escapeHtml', () => {
	test('escapes characters that break HTML text and attributes', () => {
		expect(escapeHtml(`<img src=x onerror="alert('xss')"> & "quotes"`)).toBe(
			'&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt; &amp; &quot;quotes&quot;'
		);
	});
});

describe('admin UI templates', () => {
	test('code browser avoids interpolating user data into inline handlers', () => {
		expect(codeBrowserHtml).not.toMatch(/onclick="copyToClipboard\(/);
		expect(codeBrowserHtml).not.toMatch(/onclick="copyHtmlContent\(/);
		expect(codeBrowserHtml).not.toMatch(/oncontextmenu="showContextMenu\(/);
		expect(codeBrowserHtml).not.toMatch(/onclick="filterByFolder\(/);
		expect(codeBrowserHtml).not.toContain('__ORIGIN__');
		expect(codeBrowserHtml).toContain('data-action="copy-url"');
		expect(codeBrowserHtml).toContain('href="/"');

		const script = codeBrowserHtml.slice(
			codeBrowserHtml.lastIndexOf('<script>') + '<script>'.length,
			codeBrowserHtml.lastIndexOf('</script>')
		);
		expect(() => new Function(script)).not.toThrow();
	});

	test('browse files escapes dynamic values and keeps data-url copy buttons', () => {
		expect(browseFilesHtml).toContain('escapeHtml');
		expect(browseFilesHtml).toContain('data-url=');
		expect(browseFilesHtml).toContain('data-key=');
		expect(browseFilesHtml).toContain('/api/replace-file');
		expect(browseFilesHtml).toContain('Use Replace to keep the same link');
		const script = browseFilesHtml.slice(
			browseFilesHtml.lastIndexOf('<script>') + '<script>'.length,
			browseFilesHtml.lastIndexOf('</script>')
		);
		expect(() => new Function(script)).not.toThrow();
	});
});

describe('asset serving', () => {
	test('serves code assets with cache headers and does not write analytics', async () => {
		const writes = [];
		const env = {
			...PASSWORDS,
			CDN_BUCKET: {
				get: async () => ({ body: 'console.log(1)', httpEtag: '"etag"', uploaded: new Date('2024-01-01'), size: 14 }),
				put: async (key) => writes.push(key),
			},
		};

		const response = await worker.fetch(new Request('https://files.point.com/code/prod/js/app.js'), env);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('console.log(1)');
		expect(response.headers.get('Content-Type')).toBe('application/javascript');
		expect(response.headers.get('Cache-Control')).toBe(BROWSER_CACHE_CONTROL);
		expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe(CLOUDFLARE_CACHE_CONTROL);
		expect(writes).toEqual([]);
	});

	test('redirects missing assets to point.com', async () => {
		const env = { ...PASSWORDS, CDN_BUCKET: { get: async () => null } };
		const response = await worker.fetch(new Request('https://files.point.com/missing/file.js'), env);
		expect(response.status).toBe(302);
		expect(response.headers.get('Location')).toMatch(/^https:\/\/point\.com\/?$/);
	});

	test('blocks disallowed origins for non-font code assets', async () => {
		const env = {
			...PASSWORDS,
			CDN_BUCKET: {
				get: async () => ({ body: 'x', httpEtag: '"e"', uploaded: new Date(), size: 1 }),
			},
		};
		const response = await worker.fetch(
			new Request('https://files.point.com/code/prod/js/app.js', {
				headers: { Origin: 'https://evil.example' },
			}),
			env
		);
		expect(response.status).toBe(403);
	});

	test('allows public font assets from any origin', async () => {
		const env = {
			...PASSWORDS,
			CDN_BUCKET: {
				get: async () => ({ body: 'font', httpEtag: '"e"', uploaded: new Date(), size: 4 }),
			},
		};
		const response = await worker.fetch(
			new Request('https://files.point.com/code/prod/fonts/CircularStd-Book.woff', {
				headers: { Origin: 'https://evil.example' },
			}),
			env
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});

	test('the removed stats endpoint is no longer routed', async () => {
		const env = { ...PASSWORDS, CDN_BUCKET: { get: async () => null } };
		const response = await worker.fetch(new Request('https://files.point.com/api/file-stats?file=code/prod/a.js'), env);
		expect(response.status).toBe(302);
	});
});

describe('isPublicFontAsset', () => {
	test('opens only staging and production font directories', () => {
		expect(isPublicFontAsset('code/staging/fonts/circular-std.css')).toBe(true);
		expect(isPublicFontAsset('code/prod/fonts/CircularStd-Book.woff')).toBe(true);
		expect(isPublicFontAsset('code/prod/components/nav.js')).toBe(false);
		expect(isPublicFontAsset('code/preview/fonts/font.woff')).toBe(false);
		expect(isPublicFontAsset('fonts/font.woff')).toBe(false);
	});
});

describe('password verification', () => {
	test('accepts matching passwords and rejects invalid input', async () => {
		await expect(verifyPassword('correct horse', 'correct horse')).resolves.toBe(true);
		await expect(verifyPassword('wrong horse', 'correct horse')).resolves.toBe(false);
		await expect(verifyPassword(null, 'correct horse')).resolves.toBe(false);
		await expect(verifyPassword('correct horse', undefined)).resolves.toBe(false);
	});
});

describe('browser authentication', () => {
	test('protects browse pages and APIs with a signed cookie', async () => {
		const env = {
			...PASSWORDS,
			CDN_BUCKET: {
				list: async () => ({ objects: [] }),
			},
		};

		const unauthenticatedPage = await worker.fetch(new Request('https://files.point.com/browse'), env);
		expect(await unauthenticatedPage.text()).toContain('Files Browser');
		expect(unauthenticatedPage.headers.get('Cache-Control')).toBe('no-store');

		const unauthenticatedApi = await worker.fetch(new Request('https://files.point.com/api/browse-files'), env);
		expect(unauthenticatedApi.status).toBe(401);

		const loginResponse = await worker.fetch(authRequest('/browse', PASSWORDS.UPLOAD_PASSWORD), env);
		const cookie = loginResponse.headers.get('Set-Cookie');
		expect(loginResponse.status).toBe(303);
		expect(loginResponse.headers.get('Location')).toBe('/browse');
		expect(cookie).toContain('cdn_browse_auth=');
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('Secure');
		expect(cookie).toContain('SameSite=Strict');
		expect(cookie).toContain('Max-Age=86400');
		expect(cookie).not.toContain(PASSWORDS.UPLOAD_PASSWORD);

		const authenticatedApi = await worker.fetch(
			new Request('https://files.point.com/api/browse-files', {
				headers: { Cookie: cookie.split(';')[0] },
			}),
			env
		);
		expect(authenticatedApi.status).toBe(200);
		await expect(authenticatedApi.json()).resolves.toEqual({ files: [] });
	});

	test('browse listing hides code, careers, logo gallery, and generated PDF prefixes', async () => {
		const env = {
			...PASSWORDS,
			CDN_BUCKET: {
				list: async () => ({
					objects: [
						{ key: 'hero.png', uploaded: new Date('2026-08-01') },
						{ key: 'code/prod/js/app.js', uploaded: new Date('2026-08-02') },
						{ key: 'marketing-tools/tools/pdf-batch/logos/acme.png', uploaded: new Date('2026-08-03') },
						{ key: 'marketing/tools/pdf-batch/broker-pdfs/acme.pdf', uploaded: new Date('2026-08-04') },
						{ key: 'careers/job-board.js', uploaded: new Date('2026-08-05') },
					],
				}),
			},
		};
		const cookie = await authenticatedCookie('/browse', PASSWORDS.UPLOAD_PASSWORD);
		const response = await worker.fetch(
			new Request('https://files.point.com/api/browse-files', {
				headers: { Cookie: cookie },
			}),
			env
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			files: [
				{
					key: 'hero.png',
					url: 'https://files.point.com/hero.png',
					lastModified: new Date('2026-08-01').toISOString(),
					replaceable: true,
				},
			],
		});
	});

	test('keeps code credentials out of redirects and generated pages', async () => {
		const loginResponse = await worker.fetch(authRequest('/code', PASSWORDS.CODE_PASSWORD), PASSWORDS);
		const cookie = loginResponse.headers.get('Set-Cookie');
		expect(loginResponse.status).toBe(303);
		expect(loginResponse.headers.get('Location')).toBe('/code');
		expect(cookie).not.toContain(PASSWORDS.CODE_PASSWORD);

		const pageResponse = await worker.fetch(
			new Request('https://files.point.com/code', {
				headers: { Cookie: cookie.split(';')[0] },
			}),
			PASSWORDS
		);
		const page = await pageResponse.text();
		expect(pageResponse.status).toBe(200);
		expect(page).not.toContain(PASSWORDS.CODE_PASSWORD);
		expect(page).not.toContain('password=');
	});

	test('rejects incorrect browse and code passwords', async () => {
		const browseResponse = await worker.fetch(authRequest('/browse', 'incorrect'), PASSWORDS);
		const codeResponse = await worker.fetch(authRequest('/code', 'incorrect'), PASSWORDS);
		expect(browseResponse.status).toBe(401);
		expect(codeResponse.status).toBe(401);
	});

	test('upload login unlocks the password-free upload form and browse page', async () => {
		const env = {
			...PASSWORDS,
			CDN_BUCKET: {
				get: async () => null,
				put: async () => undefined,
				list: async () => ({ objects: [] }),
			},
		};

		const unauthenticatedUploadPage = await worker.fetch(new Request('https://files.point.com/upload'), env);
		const loginPage = await unauthenticatedUploadPage.text();
		expect(loginPage).toContain('name="password"');
		expect(loginPage).not.toContain('name="file"');

		const loginResponse = await worker.fetch(authRequest('/upload', PASSWORDS.UPLOAD_PASSWORD), env);
		const cookie = loginResponse.headers.get('Set-Cookie');
		expect(loginResponse.status).toBe(303);
		expect(loginResponse.headers.get('Location')).toBe('/upload');
		expect(cookie).toContain('cdn_browse_auth=');
		expect(cookie).toContain('Max-Age=86400');

		const authenticatedUploadPage = await worker.fetch(
			new Request('https://files.point.com/upload', {
				headers: { Cookie: cookie.split(';')[0] },
			}),
			env
		);
		const uploadPage = await authenticatedUploadPage.text();
		expect(uploadPage).toContain('name="file"');
		expect(uploadPage).not.toContain('name="password"');

		const browseResponse = await worker.fetch(
			new Request('https://files.point.com/browse', {
				headers: { Cookie: cookie.split(';')[0] },
			}),
			env
		);
		expect(browseResponse.status).toBe(200);
		expect(await browseResponse.text()).toContain('Point CDN Files');
	});

	test('the code browser page is served from the HTML module with a parseable script', async () => {
		const cookie = await authenticatedCookie('/code', PASSWORDS.CODE_PASSWORD);
		const pageResponse = await worker.fetch(
			new Request('https://files.point.com/code', {
				headers: { Cookie: cookie },
			}),
			PASSWORDS
		);
		const page = await pageResponse.text();

		const script = page.slice(page.lastIndexOf('<script>') + '<script>'.length, page.lastIndexOf('</script>'));
		expect(script.length).toBeGreaterThan(100);
		expect(() => new Function(script)).not.toThrow();

		expect(page).toContain('Delete File');
		expect(page).toContain('data-action="copy-url"');
		expect(page).not.toContain('View Stats');
		expect(page).not.toContain('__ORIGIN__');
		expect(page).not.toContain('__BROWSER_NAME__');
	});

	test('password and success pages HTML-escape untrusted values', async () => {
		const evil = `<img src=x onerror="alert('x')">`;
		const badLogin = await worker.fetch(authRequest('/code', evil), PASSWORDS);
		const loginHtml = await badLogin.text();
		expect(loginHtml).toContain('Invalid password');
		expect(loginHtml).not.toContain('<img src=x');

		const env = {
			...PASSWORDS,
			CDN_BUCKET: {
				get: async () => null,
				put: async () => undefined,
			},
		};
		const cookie = await authenticatedCookie('/upload', PASSWORDS.UPLOAD_PASSWORD);
		const formData = new FormData();
		formData.set('file', new File(['image'], `logo${evil}.png`, { type: 'image/png' }));

		const uploadResponse = await worker.fetch(
			new Request('https://files.point.com/upload', {
				method: 'POST',
				headers: { Cookie: cookie },
				body: formData,
			}),
			env
		);
		const successHtml = await uploadResponse.text();
		expect(uploadResponse.status).toBe(200);
		expect(successHtml).toContain('Upload Successful');
		expect(successHtml).not.toContain('<img src=x');
		expect(successHtml).toContain('&lt;img');
	});

	test('an authenticated upload does not require the password again', async () => {
		const env = {
			...PASSWORDS,
			CDN_BUCKET: {
				get: async () => null,
				put: async () => undefined,
			},
		};
		const loginResponse = await worker.fetch(authRequest('/upload', PASSWORDS.UPLOAD_PASSWORD), env);
		const cookie = loginResponse.headers.get('Set-Cookie');
		const formData = new FormData();
		formData.set('file', new File(['image'], 'logo.png', { type: 'image/png' }));

		const uploadResponse = await worker.fetch(
			new Request('https://files.point.com/upload', {
				method: 'POST',
				headers: { Cookie: cookie.split(';')[0] },
				body: formData,
			}),
			env
		);
		expect(uploadResponse.status).toBe(200);
		expect(await uploadResponse.text()).toContain('Upload Successful');
	});
});

describe('replaceable upload keys', () => {
	test('allows public uploaded assets and rejects protected prefixes', () => {
		expect(isReplaceableUploadKey('logo.png')).toBe(true);
		expect(isReplaceableUploadKey('images/hero.jpg')).toBe(true);
		expect(isReplaceableUploadKey('code/prod/js/app.js')).toBe(false);
		expect(isReplaceableUploadKey('marketing-tools/tools/pdf-batch/logos/a.png')).toBe(false);
		expect(isReplaceableUploadKey('marketing/tools/pdf-batch/broker-pdfs/acme.pdf')).toBe(false);
		expect(isReplaceableUploadKey('careers/job-board.js')).toBe(false);
		expect(isReplaceableUploadKey('../logo.png')).toBe(false);
		expect(isReplaceableUploadKey('/logo.png')).toBe(false);
		expect(fileExtensionsMatch('logo.png', 'new-logo.PNG')).toBe(true);
		expect(fileExtensionsMatch('logo.png', 'logo.jpg')).toBe(false);
	});
});

describe('cache purge helpers', () => {
	test('purges the public URL and download variant', () => {
		expect(purgeUrlsForCdnKey('https://files.point.com', 'folder/my file.png')).toEqual([
			'https://files.point.com/folder/my%20file.png',
			'https://files.point.com/folder/my%20file.png?download=true',
		]);
	});

	test('skips purge when Cloudflare credentials are missing', async () => {
		await expect(purgeCloudflareFiles({}, ['https://files.point.com/logo.png'])).resolves.toEqual({
			ok: false,
			skipped: true,
		});
	});

	test('posts matching URLs to the Cloudflare purge API', async () => {
		const calls = [];
		const fetchImpl = async (url, init) => {
			calls.push({ url, init });
			return new Response(JSON.stringify({ success: true }), { status: 200 });
		};

		const result = await purgeCloudflareFiles(
			{ CF_ZONE_ID: 'zone-1', CF_API_TOKEN: 'token-1' },
			['https://files.point.com/logo.png'],
			fetchImpl
		);

		expect(result).toEqual({ ok: true, skipped: false });
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache');
		expect(calls[0].init.headers.Authorization).toBe('Bearer token-1');
		expect(JSON.parse(calls[0].init.body)).toEqual({ files: ['https://files.point.com/logo.png'] });
	});
});

describe('replace uploaded files', () => {
	async function replaceRequest(env, { key, name, type = 'image/png', cookie }) {
		const formData = new FormData();
		formData.set('file', new File(['new-bytes'], name, { type }));
		formData.set('key', key);
		return worker.fetch(
			new Request('https://files.point.com/api/replace-file', {
				method: 'POST',
				headers: cookie ? { Cookie: cookie } : undefined,
				body: formData,
			}),
			env
		);
	}

	test('overwrites an existing uploaded object and purges its CDN URL', async () => {
		const puts = [];
		const fetchCalls = [];
		const env = {
			...PASSWORDS,
			CDN_PUBLIC_BASE: 'https://files.point.com',
			CF_ZONE_ID: 'zone-1',
			CF_API_TOKEN: 'token-1',
			CDN_BUCKET: {
				head: async (key) => (key === 'logo.png' ? { httpMetadata: { contentType: 'image/png' } } : null),
				put: async (key, _body, options) => puts.push({ key, options }),
			},
		};
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (url, init) => {
			fetchCalls.push({ url, init });
			return new Response(JSON.stringify({ success: true }), { status: 200 });
		};

		try {
			const cookie = await authenticatedCookie('/browse', PASSWORDS.UPLOAD_PASSWORD);
			const response = await replaceRequest(env, { key: 'logo.png', name: 'logo.png', cookie });
			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toEqual({
				success: true,
				key: 'logo.png',
				url: 'https://files.point.com/logo.png',
				cachePurged: true,
				cacheSkipped: false,
			});
			expect(puts).toEqual([
				{ key: 'logo.png', options: { httpMetadata: { contentType: 'image/png' } } },
			]);
			expect(fetchCalls[0].url).toContain('/zones/zone-1/purge_cache');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('rejects unauthenticated, missing, protected, and extension-mismatched replacements', async () => {
		const env = {
			...PASSWORDS,
			CDN_BUCKET: {
				head: async () => ({ httpMetadata: { contentType: 'image/png' } }),
				put: async () => undefined,
			},
		};

		const unauthenticated = await replaceRequest(env, { key: 'logo.png', name: 'logo.png' });
		expect(unauthenticated.status).toBe(401);

		const cookie = await authenticatedCookie('/browse', PASSWORDS.UPLOAD_PASSWORD);
		const missing = await worker.fetch(
			new Request('https://files.point.com/api/replace-file', {
				method: 'POST',
				headers: { Cookie: cookie },
				body: (() => {
					const formData = new FormData();
					formData.set('key', 'logo.png');
					return formData;
				})(),
			}),
			env
		);
		expect(missing.status).toBe(400);

		const protectedFile = await replaceRequest(env, {
			key: 'code/prod/js/app.js',
			name: 'app.js',
			type: 'application/javascript',
			cookie,
		});
		expect(protectedFile.status).toBe(403);

		const mismatched = await replaceRequest(env, { key: 'logo.png', name: 'logo.jpg', type: 'image/jpeg', cookie });
		expect(mismatched.status).toBe(400);

		const absent = await replaceRequest(
			{ ...env, CDN_BUCKET: { head: async () => null, put: async () => undefined } },
			{ key: 'logo.png', name: 'logo.png', cookie }
		);
		expect(absent.status).toBe(404);
	});

	test('upload still suffixes instead of overwriting an existing name', async () => {
		const puts = [];
		const env = {
			...PASSWORDS,
			CDN_BUCKET: {
				get: async (key) => (key === 'logo.png' ? { key } : null),
				put: async (key) => puts.push(key),
			},
		};
		const cookie = await authenticatedCookie('/upload', PASSWORDS.UPLOAD_PASSWORD);
		const formData = new FormData();
		formData.set('file', new File(['image'], 'logo.png', { type: 'image/png' }));

		const response = await worker.fetch(
			new Request('https://files.point.com/upload', {
				method: 'POST',
				headers: { Cookie: cookie },
				body: formData,
			}),
			env
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('https://files.point.com/logo-1.png');
		expect(puts).toEqual(['logo-1.png']);
	});
});
