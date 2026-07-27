import { describe, expect, test } from 'vitest';
import { BROWSER_CACHE_CONTROL, CLOUDFLARE_CACHE_CONTROL, isPublicFontAsset } from './index.js';

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
