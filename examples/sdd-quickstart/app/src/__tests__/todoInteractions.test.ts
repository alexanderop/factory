import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import ui from '@nuxt/ui/vue-plugin';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import App from '../App.vue';

function findFilterButton(
	wrapper: VueWrapper,
	label: 'all' | 'active' | 'done',
): DOMWrapper<Element> {
	const buttons = wrapper.findAll('button');
	const match = buttons.find((b) => b.text().trim().toLowerCase() === label);
	if (!match) throw new Error(`filter button "${label}" not found`);
	return match;
}

function findItemByText(wrapper: VueWrapper, text: string): DOMWrapper<Element> {
	const items = wrapper.findAll('[data-testid="todo-item"]');
	const match = items.find((li) => li.text().includes(text));
	if (!match) throw new Error(`todo item with text "${text}" not found`);
	return match;
}

function visibleItemTexts(wrapper: VueWrapper): string[] {
	return wrapper
		.findAll('[data-testid="todo-item"]')
		.map((li) => li.find('[data-testid="todo-text"]').text());
}

describe('todo interactions in dark mode', () => {
	beforeEach(() => {
		document.documentElement.classList.remove('dark');
		localStorage.clear();
	});

	afterEach(() => {
		document.documentElement.classList.remove('dark');
		localStorage.clear();
	});

	it('supports add, toggle, delete, filter and clear-completed with semantic Nuxt UI tokens', async () => {
		const wrapper = mount(App, {
			global: { plugins: [ui] },
			attachTo: document.body,
		});

		// Switch to dark mode via the user-visible toggle (mirrors real usage).
		await wrapper.get('[aria-label="Toggle theme"]').trigger('click');
		expect(document.documentElement.classList.contains('dark')).toBe(true);

		// --- ADD ---
		const input = wrapper.get('input[type="text"]');
		await input.setValue('Buy milk');
		await wrapper.get('form').trigger('submit.prevent');

		expect(visibleItemTexts(wrapper)).toContain('Buy milk');

		// --- TOGGLE ---
		const newItem = findItemByText(wrapper, 'Buy milk');
		const checkbox = newItem.find('input[type="checkbox"], [role="checkbox"]');
		await checkbox.trigger('click');

		const toggledText = findItemByText(wrapper, 'Buy milk').find('[data-testid="todo-text"]');
		expect(toggledText.classes()).toContain('line-through');
		expect(toggledText.classes()).toContain('text-dimmed');

		// --- FILTER: active hides done items ---
		await findFilterButton(wrapper, 'active').trigger('click');
		expect(visibleItemTexts(wrapper)).not.toContain('Buy milk');
		expect(visibleItemTexts(wrapper)).not.toContain('Try Nuxt UI');
		expect(visibleItemTexts(wrapper)).toContain('Build a to-do list');

		// --- FILTER: done shows only done items ---
		await findFilterButton(wrapper, 'done').trigger('click');
		expect(visibleItemTexts(wrapper)).toContain('Buy milk');
		expect(visibleItemTexts(wrapper)).toContain('Try Nuxt UI');
		expect(visibleItemTexts(wrapper)).not.toContain('Build a to-do list');

		// --- FILTER: all shows everything ---
		await findFilterButton(wrapper, 'all').trigger('click');
		expect(visibleItemTexts(wrapper).length).toBe(4);

		// --- DELETE ---
		const deleteBtn = findItemByText(wrapper, 'Buy milk').get('[aria-label="Delete"]');
		await deleteBtn.trigger('click');
		expect(visibleItemTexts(wrapper)).not.toContain('Buy milk');

		// --- CLEAR COMPLETED ---
		const clearBtn = wrapper
			.findAll('button')
			.find((b) => b.text().trim().toLowerCase() === 'clear completed');
		if (!clearBtn) throw new Error('clear completed button missing');
		await clearBtn.trigger('click');
		expect(visibleItemTexts(wrapper)).not.toContain('Try Nuxt UI');
		expect(visibleItemTexts(wrapper)).toContain('Build a to-do list');
		expect(visibleItemTexts(wrapper)).toContain('Add dark mode');

		// Still in dark mode after all interactions.
		expect(document.documentElement.classList.contains('dark')).toBe(true);

		// --- READABLE CONTRAST: no hardcoded gray/black/white tailwind colors anywhere ---
		const html = wrapper.html();
		expect(html).not.toMatch(
			/\b(?:text|bg|border|divide)-(?:gray|zinc|slate|neutral|stone)-\d{2,3}\b/,
		);
		expect(html).not.toMatch(/\b(?:text|bg)-(?:black|white)\b/);

		wrapper.unmount();
	});
});
