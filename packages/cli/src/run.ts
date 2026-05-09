import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initOtel, shutdownOtel } from '@factory/core';
import type { Factory } from '@factory/core';

interface ParsedArgs {
	name: string;
	prd: string;
	cwd: string;
	otel: boolean;
}

export async function run(argv: string[]): Promise<number> {
	const parsed = parseArgs(argv);
	if (!parsed) return 1;

	if (parsed.otel) initOtel();

	try {
		const factoryDef = await loadFactoryFile(parsed.cwd, parsed.name);
		await factoryDef.run({
			prd: parsed.prd,
			cwd: parsed.cwd,
			onStep: (event) => console.log(`[${event.type}]`, event),
			onError: (event) => console.error('[error]', event.error),
		});
		return 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		return 1;
	} finally {
		if (parsed.otel) await shutdownOtel();
	}
}

function parseArgs(argv: string[]): ParsedArgs | undefined {
	const [name, ...rest] = argv;
	if (!name) {
		console.error('usage: factory run <name> --prd <file|text>');
		return undefined;
	}

	let prd: string | undefined;
	let cwd = process.cwd();
	let otel = process.env.OTEL_SDK_DISABLED !== 'true';

	for (let i = 0; i < rest.length; i++) {
		const flag = rest[i];
		if (flag === '--prd') {
			prd = rest[++i];
		} else if (flag === '--cwd') {
			const next = rest[++i];
			if (next) cwd = isAbsolute(next) ? next : resolve(process.cwd(), next);
		} else if (flag === '--no-otel') {
			otel = false;
		} else {
			console.error(`unknown flag: ${flag}`);
			return undefined;
		}
	}

	if (!prd) {
		console.error('--prd <file|text> is required');
		return undefined;
	}

	return { name, prd: resolvePrd(prd, cwd), cwd, otel };
}

function resolvePrd(value: string, cwd: string): string {
	const path = isAbsolute(value) ? value : resolve(cwd, value);
	if (existsSync(path)) {
		// fire-and-forget read happens lazily later — but we want the resolved text now for state.
		// Keep this synchronous-ish: caller treats string as text or path interchangeably.
		return path;
	}
	return value;
}

async function loadFactoryFile(cwd: string, name: string): Promise<Factory> {
	const candidates = [
		resolve(cwd, `.factory/factory.ts`),
		resolve(cwd, `.factory/factory.js`),
		resolve(cwd, `factory.config.ts`),
		resolve(cwd, `factory.config.js`),
	];

	for (const path of candidates) {
		if (!existsSync(path)) continue;
		const mod = await import(pathToFileURL(path).href);
		const def = (mod.default ?? mod[name]) as Factory | undefined;
		if (!def) {
			throw new Error(`${path} does not export a factory (default export or named '${name}')`);
		}
		if (def.name !== name) {
			throw new Error(`factory in ${path} is named '${def.name}', expected '${name}'`);
		}
		return def;
	}

	throw new Error(
		`no factory config found in ${cwd}. Expected one of: ${candidates.map((p) => p.replace(`${cwd}/`, '')).join(', ')}`,
	);
}

// keep the import to silence unused warnings until fs reads are wired in
void readFile;
