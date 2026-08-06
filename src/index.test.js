import { describe, expect, test } from 'vitest';
import worker, {
	BROWSER_CACHE_CONTROL,
	CLOUDFLARE_CACHE_CONTROL,
	escapeHtml,
	isPublicFontAsset,
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
