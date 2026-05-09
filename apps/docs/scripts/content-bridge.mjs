#!/usr/bin/env node
// Content bridge for @factory/docs.
//
// Mirrors canonical markdown sources at the repo root into Starlight's
// content collection so they render in the docs site. The canonical files
// stay where CLAUDE.md and the agent workflow expect them.
//
//   /patterns/*.md           → apps/docs/src/content/docs/patterns/*.md
//   /docs/feature-specs/*.md → apps/docs/src/content/docs/feature-specs/*.md
//
// Each mirrored file gets an `editUrl` injected into its frontmatter so the
// "Edit this page" link in Starlight resolves to the canonical path on
// GitHub, not the mirrored copy under apps/docs/.
//
// Run once: `node ./scripts/content-bridge.mjs`
// Watch mode: `node ./scripts/content-bridge.mjs --watch`
//   (used by `pnpm dev` so HMR fires when the canonical files change)

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsRoot = join(__dirname, '..');
const repoRoot = join(docsRoot, '..', '..');
const destBase = join(docsRoot, 'src', 'content', 'docs');

const githubEditBase = 'https://github.com/alexanderop/factory/edit/main';

const sources = [
	{
		srcDir: join(repoRoot, 'patterns'),
		destDir: join(destBase, 'patterns'),
		repoPath: 'patterns',
	},
	{
		srcDir: join(repoRoot, 'docs', 'feature-specs'),
		destDir: join(destBase, 'feature-specs'),
		repoPath: 'docs/feature-specs',
	},
];

function deriveTitle(body, fileName) {
	const heading = body.match(/^#\s+(.+?)\s*$/m);
	if (heading) return heading[1].replace(/^Feature:\s*/i, '').trim();
	return fileName
		.replace(/\.md$/, '')
		.split(/[-_]/)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

function escapeYamlString(value) {
	return `'${value.replace(/'/g, "''")}'`;
}

function ensureFrontmatter(content, additions) {
	const fmRe = /^---\n([\s\S]*?)\n---\n?/;
	const match = content.match(fmRe);
	const lines = [];
	let body;
	let existing = '';
	if (match) {
		existing = match[1];
		body = content.slice(match[0].length);
	} else {
		body = content;
	}
	for (const [key, value] of Object.entries(additions)) {
		const keyRe = new RegExp(`^${key}:`, 'm');
		if (keyRe.test(existing)) continue;
		lines.push(`${key}: ${value}`);
	}
	const merged = [existing, ...lines].filter(Boolean).join('\n');
	return `---\n${merged}\n---\n${body.startsWith('\n') ? body : `\n${body}`}`;
}

async function mirror({ srcDir, destDir, repoPath }) {
	if (!existsSync(srcDir)) {
		throw new Error(`content-bridge: source directory not found: ${srcDir}`);
	}
	await rm(destDir, { recursive: true, force: true });
	await mkdir(destDir, { recursive: true });
	const entries = await readdir(srcDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
		const src = join(srcDir, entry.name);
		const dest = join(destDir, entry.name);
		const raw = await readFile(src, 'utf8');
		const editUrl = `${githubEditBase}/${repoPath}/${entry.name}`;
		const title = deriveTitle(raw, entry.name);
		const transformed = ensureFrontmatter(raw, {
			title: escapeYamlString(title),
			editUrl,
		});
		await writeFile(dest, transformed, 'utf8');
	}
}

async function mirrorAll() {
	for (const source of sources) {
		await mirror(source);
	}
}

async function main() {
	const watch = process.argv.includes('--watch');
	await mirrorAll();
	console.log(
		`[content-bridge] mirrored ${sources.map((s) => s.repoPath).join(', ')} → src/content/docs/`,
	);
	if (!watch) return;

	const { default: chokidar } = await import('chokidar');
	const watcher = chokidar.watch(
		sources.map((s) => s.srcDir),
		{ ignoreInitial: true },
	);
	let pending = false;
	let running = false;
	const schedule = () => {
		if (running) {
			pending = true;
			return;
		}
		running = true;
		mirrorAll()
			.then(() => {
				console.log('[content-bridge] re-mirrored after change');
			})
			.catch((err) => {
				console.error('[content-bridge] mirror failed:', err);
			})
			.finally(() => {
				running = false;
				if (pending) {
					pending = false;
					schedule();
				}
			});
	};
	watcher.on('all', schedule);
	console.log('[content-bridge] watching for changes…');
}

main().catch((err) => {
	console.error('[content-bridge] fatal:', err);
	process.exit(1);
});
