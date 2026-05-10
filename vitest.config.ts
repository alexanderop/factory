import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['packages/*/src/**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/dist/**', 'apps/**', 'repos/**'],
		environment: 'node',
		passWithNoTests: false,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'html', 'lcov'],
			include: ['packages/*/src/**/*.ts'],
			exclude: [
				'**/*.test.ts',
				'**/index.ts',
				'packages/cli/src/main.ts',
				'repos/**',
				'apps/**',
				'examples/**',
			],
		},
	},
});
