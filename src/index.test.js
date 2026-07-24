import { describe, expect, test } from 'vitest';
import { isPublicFontAsset } from './index.js';

describe('isPublicFontAsset', () => {
	test('opens only staging and production font directories', () => {
		expect(isPublicFontAsset('code/staging/fonts/circular-std.css')).toBe(true);
		expect(isPublicFontAsset('code/prod/fonts/CircularStd-Book.woff')).toBe(true);
		expect(isPublicFontAsset('code/prod/components/nav.js')).toBe(false);
		expect(isPublicFontAsset('code/preview/fonts/font.woff')).toBe(false);
		expect(isPublicFontAsset('fonts/font.woff')).toBe(false);
	});
});
