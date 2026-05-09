import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import matter from 'gray-matter';
import type { LoadedStep, StepFrontmatter } from './types.ts';

export async function loadStep(source: string, cwd: string): Promise<LoadedStep> {
	const path = isAbsolute(source) ? source : resolve(cwd, source);
	const raw = await readFile(path, 'utf8');
	const parsed = matter(raw);
	const frontmatter = parsed.data as StepFrontmatter;
	return {
		id: frontmatter.name ?? path,
		path,
		frontmatter,
		prompt: parsed.content.trim(),
	};
}
