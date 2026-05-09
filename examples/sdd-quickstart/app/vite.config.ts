/// <reference types="vitest" />
import vue from '@vitejs/plugin-vue';
import ui from '@nuxt/ui/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [vue(), ui()],
	test: {
		environment: 'jsdom',
		globals: true,
	},
});
