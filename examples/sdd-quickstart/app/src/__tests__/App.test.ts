import { mount } from '@vue/test-utils';
import ui from '@nuxt/ui/vue-plugin';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import App from '../App.vue';

describe('header theme toggle', () => {
	beforeEach(() => {
		document.documentElement.classList.remove('dark');
		localStorage.clear();
	});

	afterEach(() => {
		document.documentElement.classList.remove('dark');
		localStorage.clear();
	});

	it('flips the document class and persists the choice when clicked', async () => {
		const wrapper = mount(App, {
			global: { plugins: [ui] },
			attachTo: document.body,
		});

		const toggle = wrapper.get('[aria-label="Toggle theme"]');

		await toggle.trigger('click');

		expect(document.documentElement.classList.contains('dark')).toBe(true);
		expect(localStorage.getItem('color-mode')).toBe('dark');

		await toggle.trigger('click');

		expect(document.documentElement.classList.contains('dark')).toBe(false);
		expect(localStorage.getItem('color-mode')).toBe('light');

		wrapper.unmount();
	});
});
