import { defineConfig } from 'vitest/config';

const sharedExclude = ['**/node_modules/**', '**/dist/**', 'apps/**', 'repos/**'];

export default defineConfig({
	test: {
		environment: 'node',
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
		projects: [
			{
				test: {
					name: 'unit',
					environment: 'node',
					include: ['**/*.unit.test.ts'],
					exclude: sharedExclude,
					passWithNoTests: true,
				},
			},
			{
				test: {
					name: 'integration',
					environment: 'node',
					include: ['packages/*/src/**/*.test.ts'],
					exclude: [...sharedExclude, '**/*.unit.test.ts', 'tests/e2e/**'],
				},
			},
			{
				test: {
					name: 'e2e',
					environment: 'node',
					include: ['tests/e2e/**/*.test.ts'],
					exclude: sharedExclude,
					passWithNoTests: true,
				},
			},
		],
	},
});
