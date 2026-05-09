import { mount } from '@vue/test-utils';
import ui from '@nuxt/ui/vue-plugin';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import App from '../App.vue';

describe('theme persistence across reloads', () => {
	beforeEach(() => {
		document.documentElement.classList.remove('dark');
		localStorage.clear();
	});

	afterEach(() => {
		document.documentElement.classList.remove('dark');
		localStorage.clear();
	});

	it('comes up in dark mode when a previous session stored "dark"', () => {
		localStorage.setItem('color-mode', 'dark');

		const wrapper = mount(App, {
			global: { plugins: [ui] },
			attachTo: document.body,
		});

		expect(document.documentElement.classList.contains('dark')).toBe(true);

		wrapper.unmount();
	});

	it('comes up in light mode when a previous session stored "light"', () => {
		localStorage.setItem('color-mode', 'light');
		// Document starts with the dark class (e.g. left over from inline script
		// that read a stale matchMedia) — App must clear it because storage wins.
		document.documentElement.classList.add('dark');

		const wrapper = mount(App, {
			global: { plugins: [ui] },
			attachTo: document.body,
		});

		expect(document.documentElement.classList.contains('dark')).toBe(false);

		wrapper.unmount();
	});

	it('a chosen "dark" theme survives a remount of the app', async () => {
		const first = mount(App, {
			global: { plugins: [ui] },
			attachTo: document.body,
		});
		await first.get('[aria-label="Toggle theme"]').trigger('click');
		expect(localStorage.getItem('color-mode')).toBe('dark');
		first.unmount();

		// Simulate a fresh page load: the inline <head> script wouldn't have run
		// in this jsdom environment, so the document starts without the class.
		document.documentElement.classList.remove('dark');

		const second = mount(App, {
			global: { plugins: [ui] },
			attachTo: document.body,
		});

		expect(document.documentElement.classList.contains('dark')).toBe(true);

		second.unmount();
	});
});
