#!/usr/bin/env -S node --experimental-strip-types
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import factoryDef from '../.factory/factory.ts';

const exists = (path: string): Promise<boolean> =>
	access(path).then(
		() => true,
		() => false,
	);

const cwd = resolve(process.cwd());
const prd = resolve(cwd, process.argv[2] ?? 'plans/effect-review-red.md');

if (!(await exists(prd))) {
	console.error(`prd not found: ${prd}`);
	process.exit(1);
}

console.log(`dogfood: prd=${prd}`);
await factoryDef.run({ prd, cwd });
