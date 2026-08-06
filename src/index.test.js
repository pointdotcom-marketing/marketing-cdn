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

	test('a successful upload also authenticates the browse page', async () => {
		const formData = new FormData();
		formData.set('password', PASSWORDS.UPLOAD_PASSWORD);
		formData.set('file', new File(['image'], 'logo.png', { type: 'image/png' }));
		const env = {
			...PASSWORDS,
			CDN_BUCKET: {
				get: async () => null,
				put: async () => undefined,
				list: async () => ({ objects: [] }),
			},
		};

		const uploadResponse = await worker.fetch(
			new Request('https://files.point.com/upload', {
				method: 'POST',
				body: formData,
			}),
			env
		);
		const cookie = uploadResponse.headers.get('Set-Cookie');
		expect(uploadResponse.status).toBe(200);
		expect(cookie).toContain('cdn_browse_auth=');
		expect(cookie).toContain('Max-Age=86400');

		const browseResponse = await worker.fetch(
			new Request('https://files.point.com/browse', {
				headers: { Cookie: cookie.split(';')[0] },
			}),
			env
		);
		expect(browseResponse.status).toBe(200);
		expect(await browseResponse.text()).toContain('Point CDN Files');
	});
});
