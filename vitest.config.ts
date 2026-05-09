import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['packages/*/src/**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/dist/**', 'apps/**', 'repos/**'],
		environment: 'node',
		passWithNoTests: false,
	},
});
