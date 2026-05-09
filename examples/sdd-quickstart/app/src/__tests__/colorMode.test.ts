import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyInitialColorMode, toggleColorMode } from '../colorMode.ts';

describe('applyInitialColorMode (system preference default)', () => {
	beforeEach(() => {
		document.documentElement.classList.remove('dark');
	});

	it('adds the dark class to the document when the system prefers dark', () => {
		applyInitialColorMode({ prefersDark: () => true, getStored: () => null });

		expect(document.documentElement.classList.contains('dark')).toBe(true);
	});

	it('omits the dark class when the system prefers light', () => {
		applyInitialColorMode({ prefersDark: () => false, getStored: () => null });

		expect(document.documentElement.classList.contains('dark')).toBe(false);
	});
});

describe('applyInitialColorMode (stored preference)', () => {
	beforeEach(() => {
		document.documentElement.classList.remove('dark');
	});

	it('honors a stored "dark" preference even when the system prefers light', () => {
		applyInitialColorMode({ prefersDark: () => false, getStored: () => 'dark' });

		expect(document.documentElement.classList.contains('dark')).toBe(true);
	});

	it('honors a stored "light" preference even when the system prefers dark', () => {
		applyInitialColorMode({ prefersDark: () => true, getStored: () => 'light' });

		expect(document.documentElement.classList.contains('dark')).toBe(false);
	});
});

describe('toggleColorMode', () => {
	beforeEach(() => {
		document.documentElement.classList.remove('dark');
	});

	it('flips the document class and persists the new mode', () => {
		const setStored = vi.fn();

		toggleColorMode({ setStored });

		expect(document.documentElement.classList.contains('dark')).toBe(true);
		expect(setStored).toHaveBeenCalledWith('dark');

		toggleColorMode({ setStored });

		expect(document.documentElement.classList.contains('dark')).toBe(false);
		expect(setStored).toHaveBeenLastCalledWith('light');
	});
});
