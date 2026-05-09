import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const indexHtml = readFileSync(resolve(__dirname, '..', '..', 'index.html'), 'utf8');

function extractInlineHeadScript(html: string): string {
	const head = html.split('</head>')[0];
	const match = head.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/);
	if (!match) throw new Error('no inline <script> found in <head>');
	return match[1];
}

describe('no flash before mount (system-preference-default)', () => {
	beforeEach(() => {
		document.documentElement.classList.remove('dark');
	});

	afterEach(() => {
		document.documentElement.classList.remove('dark');
	});

	it('index.html ships a synchronous inline color-mode script in <head>', () => {
		const head = indexHtml.split('</head>')[0];
		const inlineScripts = head.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g);
		expect(inlineScripts).not.toBeNull();
		const colorModeScript = inlineScripts!.find((s) => /prefers-color-scheme|color-mode/.test(s));
		expect(colorModeScript).toBeDefined();
	});

	it('inline script adds the dark class when the system prefers dark and storage is empty', () => {
		const code = extractInlineHeadScript(indexHtml);

		runInNewContext(code, {
			window: {
				matchMedia: (query: string) => ({
					matches: query === '(prefers-color-scheme: dark)',
				}),
			},
			document,
			localStorage: { getItem: () => null },
		});

		expect(document.documentElement.classList.contains('dark')).toBe(true);
	});

	it('inline script honors a stored "light" preference even when the system prefers dark', () => {
		const code = extractInlineHeadScript(indexHtml);

		runInNewContext(code, {
			window: {
				matchMedia: (_query: string) => ({ matches: true }),
			},
			document,
			localStorage: { getItem: () => 'light' },
		});

		expect(document.documentElement.classList.contains('dark')).toBe(false);
	});
});
