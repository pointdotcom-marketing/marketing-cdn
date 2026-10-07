import { describe, expect, test } from 'vitest';
import worker, {
	ADMIN_REDIRECTS,
	BROWSER_CACHE_CONTROL,
	CLOUDFLARE_CACHE_CONTROL,
	isPublicFontAsset,
	isReplaceableUploadKey,
	REDIRECT_METADATA_KEY,
	redirectTargetKey,
} from './index.js';

const ENV = {};

describe('CDN cache policy', () => {
	test('requires browser revalidation while retaining a long-lived Cloudflare copy', () => {
		expect(BROWSER_CACHE_CONTROL).toBe('public, max-age=0, must-revalidate');
		expect(CLOUDFLARE_CACHE_CONTROL).toBe('public, max-age=31536000');
	});
});

describe('asset serving', () => {
	test('serves code assets with cache headers and does not write analytics', async () => {
		const writes = [];
		const env = {
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
		const env = { CDN_BUCKET: { get: async () => null } };
		const response = await worker.fetch(new Request('https://files.point.com/missing/file.js'), env);
		expect(response.status).toBe(302);
		expect(response.headers.get('Location')).toMatch(/^https:\/\/point\.com\/?$/);
	});

	test('blocks disallowed origins for non-font code assets', async () => {
		const env = {
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
		const env = { CDN_BUCKET: { get: async () => null } };
		const response = await worker.fetch(new Request('https://files.point.com/api/file-stats?file=code/prod/a.js'), env);
		expect(response.status).toBe(302);
	});
});

// Serving contract for point.com: these pin down existing behavior so CDN Worker changes cannot
// silently alter what files.point.com returns.
function servingBucket(objects) {
	const lookups = [];
	return {
		lookups,
		bucket: {
			get: async (key, options) => {
				lookups.push(key);
				const object = objects[key];
				if (!object) return null;
				const body = object.body ?? 'x';
				const range = options?.range;
				return {
					body: range ? body.slice(range.offset, range.offset + range.length) : body,
					httpEtag: '"etag-1"',
					uploaded: new Date('2026-01-02T03:04:05Z'),
					size: body.length,
					customMetadata: object.customMetadata,
				};
			},
		},
	};
}

function serve(path, objects, init) {
	const { bucket, lookups } = servingBucket(objects);
	return worker
		.fetch(new Request(`https://files.point.com${path}`, init), { CDN_BUCKET: bucket })
		.then((response) => ({ response, lookups }));
}

describe('asset serving contract', () => {
	test('sets content type by extension and falls back to octet-stream', async () => {
		const cases = {
			'a.js': 'application/javascript',
			'a.css': 'text/css',
			'a.html': 'text/html',
			'a.json': 'application/json',
			'a.svg': 'image/svg+xml',
			'a.webp': 'image/webp',
			'a.woff2': 'font/woff2',
			'a.pdf': 'application/pdf',
			'a.mp4': 'video/mp4',
			'a.unknownext': 'application/octet-stream',
		};
		for (const [key, type] of Object.entries(cases)) {
			const { response } = await serve(`/${key}`, { [key]: {} });
			expect(response.status, key).toBe(200);
			expect(response.headers.get('Content-Type'), key).toBe(type);
		}
	});

	test('sends validators and the browser and edge cache policies', async () => {
		const { response } = await serve('/hero.png', { 'hero.png': {} });
		expect(response.headers.get('ETag')).toBe('"etag-1"');
		expect(response.headers.get('Last-Modified')).toBe('Fri, 02 Jan 2026 03:04:05 GMT');
		expect(response.headers.get('Cache-Control')).toBe(BROWSER_CACHE_CONTROL);
		expect(response.headers.get('Cloudflare-CDN-Cache-Control')).toBe(CLOUDFLARE_CACHE_CONTROL);
	});

	test('previews inline, downloads as an attachment with ?download=true', async () => {
		const objects = { 'docs/guide.pdf': {}, 'code/prod/js/app.js': {} };
		expect((await serve('/docs/guide.pdf', objects)).response.headers.get('Content-Disposition')).toBe('inline');
		expect((await serve('/code/prod/js/app.js', objects)).response.headers.get('Content-Disposition')).toBeNull();
		const { response } = await serve('/docs/guide.pdf?download=true', objects);
		expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="guide.pdf"');
	});

	test('non-code files are open to any origin', async () => {
		const { response } = await serve('/hero.png', { 'hero.png': {} }, { headers: { Origin: 'https://anywhere.example' } });
		expect(response.status).toBe(200);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});

	test('code files reflect allowed origins, allow same-site loads, and block other referers', async () => {
		const objects = { 'code/prod/js/app.js': {} };
		const allowed = await serve('/code/prod/js/app.js', objects, { headers: { Origin: 'https://point.com' } });
		expect(allowed.response.status).toBe(200);
		expect(allowed.response.headers.get('Access-Control-Allow-Origin')).toBe('https://point.com');
		expect(allowed.response.headers.get('Vary')).toBe('Origin');

		const direct = await serve('/code/prod/js/app.js', objects);
		expect(direct.response.status).toBe(200);
		expect(direct.response.headers.get('Access-Control-Allow-Origin')).toBeNull();

		const blocked = await serve('/code/prod/js/app.js', objects, { headers: { Referer: 'https://evil.example/page' } });
		expect(blocked.response.status).toBe(403);
	});

	test('mp4 advertises ranges and serves partial content', async () => {
		const objects = { 'v.mp4': { body: '0123456789' } };
		const full = await serve('/v.mp4', objects);
		expect(full.response.headers.get('Accept-Ranges')).toBe('bytes');
		expect(full.response.headers.get('Content-Length')).toBe('10');

		const ranged = await serve('/v.mp4', objects, { headers: { Range: 'bytes=2-5' } });
		expect(ranged.response.status).toBe(206);
		expect(ranged.response.headers.get('Content-Range')).toBe('bytes 2-5/10');
		expect(await ranged.response.text()).toBe('2345');

		const openEnded = await serve('/v.mp4', objects, { headers: { Range: 'bytes=4-' } });
		expect(openEnded.response.headers.get('Content-Range')).toBe('bytes 4-9/10');

		expect((await serve('/v.mp4', objects, { headers: { Range: 'items=1-2' } })).response.status).toBe(400);
		expect((await serve('/v.mp4', objects, { headers: { Range: 'bytes=20-30' } })).response.status).toBe(416);
	});

	test('looks up the path as requested, then the raw request path', async () => {
		const { response, lookups } = await serve('/folder/my%20file.png', { 'folder/my%20file.png': {} });
		expect(response.status).toBe(200);
		expect(lookups).toEqual(['folder/my%20file.png']);
	});

	test('the root and missing files redirect to point.com', async () => {
		expect((await serve('/', {})).response.headers.get('Location')).toMatch(/^https:\/\/point\.com\/?$/);
		const missing = await serve('/nope.png', {});
		expect(missing.response.status).toBe(302);
		expect(missing.response.headers.get('Location')).toMatch(/^https:\/\/point\.com\/?$/);
	});
});

describe('rename redirects and trash', () => {
	test('a rename placeholder 302s to the new key without caching and keeps the query', async () => {
		const objects = { 'old-guide-2024.pdf': { body: '', customMetadata: { [REDIRECT_METADATA_KEY]: 'guides/new guide.pdf' } } };
		const { response, lookups } = await serve('/old-guide-2024.pdf?download=true', objects);
		expect(response.status).toBe(302);
		expect(response.headers.get('Location')).toBe('https://files.point.com/guides/new%20guide.pdf?download=true');
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		expect(lookups).toHaveLength(1);
	});

	test('ordinary files with unrelated metadata are served as before', async () => {
		const { response } = await serve('/hero.png', { 'hero.png': { customMetadata: { uploadedBy: 'a@point.com' } } });
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('image/png');
	});

	test('redirect metadata is ignored in protected folders and for unsafe targets', async () => {
		const script = { 'code/prod/js/app.js': { body: 'js', customMetadata: { [REDIRECT_METADATA_KEY]: 'evil.js' } } };
		const { response } = await serve('/code/prod/js/app.js', script);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('js');

		expect(redirectTargetKey('a.pdf', { customMetadata: { [REDIRECT_METADATA_KEY]: 'code/prod/js/app.js' } })).toBeNull();
		expect(redirectTargetKey('a.pdf', { customMetadata: { [REDIRECT_METADATA_KEY]: '../x.pdf' } })).toBeNull();
		expect(redirectTargetKey('a.pdf', { customMetadata: { [REDIRECT_METADATA_KEY]: 'b.pdf' } })).toBe('b.pdf');
		expect(redirectTargetKey('a.pdf', {})).toBeNull();
	});

	test('trash is never served and is never looked up', async () => {
		const { response, lookups } = await serve('/_trash/2026-10-07/guide.pdf', { '_trash/2026-10-07/guide.pdf': {} });
		expect(response.status).toBe(302);
		expect(response.headers.get('Location')).toMatch(/^https:\/\/point\.com\/?$/);
		expect(lookups).toEqual([]);
	});

	test('trash is protected from replace', () => {
		expect(isReplaceableUploadKey('_trash/2026-10-07/guide.pdf')).toBe(false);
	});
});

describe('retired admin pages', () => {
	test('upload, browse, and code redirect to the marketing-tools hub without touching R2', async () => {
		const bucket = {
			get: async () => {
				throw new Error('admin redirects must not read R2');
			},
		};
		for (const [path, hubPath] of Object.entries(ADMIN_REDIRECTS)) {
			for (const method of ['GET', 'POST']) {
				const response = await worker.fetch(new Request(`https://files.point.com${path}`, { method }), { CDN_BUCKET: bucket });
				expect(response.status, `${method} ${path}`).toBe(302);
				expect(response.headers.get('Location')).toBe(`https://marketing-tools.ops-1df.workers.dev${hubPath}`);
				expect(response.headers.get('Cache-Control')).toBe('no-store');
			}
		}
	});

	test('only the exact admin paths redirect; old APIs and nested paths are plain file lookups', async () => {
		for (const path of ['/upload/', '/upload.png', '/browse/x', '/api/browse-files', '/api/replace-file', '/api/delete-file', '/api/files']) {
			const response = await worker.fetch(new Request(`https://files.point.com${path}`), { CDN_BUCKET: { get: async () => null } });
			expect(response.headers.get('Location'), path).toMatch(/^https:\/\/point\.com\/?$/);
		}
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
	});
});
