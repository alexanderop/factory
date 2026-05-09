// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const githubRepo = 'https://github.com/alexanderop/factory';

// Edit links for hand-authored pages under apps/docs/src/content/docs/.
// Mirrored pages (patterns/, feature-specs/) override editUrl per-page in
// frontmatter, written by scripts/content-bridge.mjs, so those links resolve
// to the canonical files at the repo root rather than to the mirrored copy.
export default defineConfig({
	integrations: [
		starlight({
			title: 'factory',
			description:
				'TypeScript framework for building software factories — multi-step coding pipelines that run AFK on top of any installed coding harness.',
			social: { github: githubRepo },
			editLink: {
				baseUrl: `${githubRepo}/edit/main/apps/docs/`,
			},
			lastUpdated: true,
			sidebar: [
				{
					label: 'Start',
					autogenerate: { directory: 'start' },
				},
				{
					label: 'Patterns',
					autogenerate: { directory: 'patterns' },
				},
				{
					label: 'Feature Specs',
					autogenerate: { directory: 'feature-specs' },
				},
				{
					label: 'Packages',
					autogenerate: { directory: 'packages' },
				},
				{
					label: 'Reference',
					autogenerate: { directory: 'reference' },
				},
			],
		}),
	],
});
