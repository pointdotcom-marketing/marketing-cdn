import { describe, expect, test } from 'vitest';
import worker, { BROWSER_CACHE_CONTROL, CLOUDFLARE_CACHE_CONTROL, isPublicFontAsset, verifyPassword } from './index.js';

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

describe('CDN cache policy', () => {
	test('requires browser revalidation while retaining a long-lived Cloudflare copy', () => {
		expect(BROWSER_CACHE_CONTROL).toBe('public, max-age=0, must-revalidate');
		expect(CLOUDFLARE_CACHE_CONTROL).toBe('public, max-age=31536000');
	});
});

describe('per-file request stats', () => {
	test('serving a code asset no longer writes analytics objects to the bucket', async () => {
		const writes = [];
		const env = {
			...PASSWORDS,
			CDN_BUCKET: {
				get: async () => ({ body: 'file-body', httpEtag: '"etag"', uploaded: new Date(), size: 9 }),
				put: async (key) => writes.push(key),
			},
		};

		const response = await worker.fetch(new Request('https://files.point.com/code/prod/js/app.js'), env);
		expect(response.status).toBe(200);
		expect(writes).toEqual([]);
	});

	test('the stats endpoint is no longer routed', async () => {
		const env = { ...PASSWORDS, CDN_BUCKET: { get: async () => null } };
		const response = await worker.fetch(new Request('https://files.point.com/api/file-stats?file=code/prod/a.js'), env);
		// Falls through to asset serving, where a missing object redirects to point.com.
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

	test('the code browser renders a parseable inline script with no stats UI', async () => {
		const loginResponse = await worker.fetch(authRequest('/code', PASSWORDS.CODE_PASSWORD), PASSWORDS);
		const cookie = loginResponse.headers.get('Set-Cookie').split(';')[0];
		const pageResponse = await worker.fetch(
			new Request('https://files.point.com/code', {
				headers: { Cookie: cookie },
			}),
			PASSWORDS
		);
		const page = await pageResponse.text();

		// The page is a template literal, so a malformed edit only surfaces when the
		// inline script is parsed. new Function throws a SyntaxError if it is broken.
		const script = page.slice(page.lastIndexOf('<script>') + '<script>'.length, page.lastIndexOf('</script>'));
		expect(script.length).toBeGreaterThan(100);
		expect(() => new Function(script)).not.toThrow();

		expect(page).toContain('Delete File');
		expect(page).not.toContain('View Stats');
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
