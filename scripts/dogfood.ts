#!/usr/bin/env -S node --experimental-strip-types
import { execSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import factoryDef from '../.factory/factory.ts';

const cwd = resolve(process.cwd());
const lastPrdFile = join(cwd, '.factory', 'last-prd');

const exists = (path: string): Promise<boolean> =>
	access(path).then(
		() => true,
		() => false,
	);

const preflight = (): void => {
	const status = execSync('git status --porcelain', { cwd, encoding: 'utf8' });
	if (status.trim()) {
		console.error('dogfood: working tree is dirty — commit or stash first.');
		console.error(status);
		process.exit(2);
	}
	const branch = execSync('git rev-parse --abbrev-ref HEAD', {
		cwd,
		encoding: 'utf8',
	}).trim();
	if (branch !== 'main') {
		console.error(`dogfood: must be on main, currently on ${branch}.`);
		console.error('  the branch step creates a fresh branch off main for you.');
		process.exit(2);
	}
};

const resolvePrd = async (): Promise<string> => {
	const arg = process.argv[2];
	if (arg) return resolve(cwd, arg);
	if (await exists(lastPrdFile)) {
		const cached = (await readFile(lastPrdFile, 'utf8')).trim();
		if (cached) {
			console.log(`dogfood: reusing last PRD (${cached})`);
			return cached;
		}
	}
	console.error('dogfood: no PRD given and no .factory/last-prd cached.');
	console.error('  usage: pnpm dogfood plans/<topic>.md');
	process.exit(1);
};

preflight();
const prd = await resolvePrd();

if (!(await exists(prd))) {
	console.error(`prd not found: ${prd}`);
	process.exit(1);
}

await writeFile(lastPrdFile, `${prd}\n`, 'utf8');

console.log(`dogfood: prd=${prd}`);
await factoryDef.run({ prd, cwd });
