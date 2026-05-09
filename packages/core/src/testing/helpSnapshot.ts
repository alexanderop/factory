import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface HelpSnapshotArgs {
	readonly bin: string;
	readonly fixturePath: string;
	readonly args?: ReadonlyArray<string>;
}

/**
 * Drift-detection harness for upstream CLI `--help` output.
 *
 * Spawns `<bin> <args>` (default `--help`), compares stdout against a fixture
 * file, and fails with a clear message when they diverge. Set
 * `UPDATE_FIXTURES=1` to write/refresh the fixture instead of asserting.
 *
 * Designed to be wrapped in `it.skipIf(!process.env.HARNESS_LIVE)` so it only
 * runs when the upstream binary is actually installed.
 */
export const assertHelpSnapshot = (opts: HelpSnapshotArgs): void => {
	const cliArgs = opts.args ?? ['--help'];
	const result = spawnSync(opts.bin, [...cliArgs], {
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 10_000,
		encoding: 'utf-8',
	});
	if (result.status !== 0) {
		throw new Error(
			`'${opts.bin} ${cliArgs.join(' ')}' failed (exit ${result.status ?? 'null'}): ${result.stderr}`,
		);
	}
	const actual = result.stdout;
	const update = process.env.UPDATE_FIXTURES === '1';

	if (!existsSync(opts.fixturePath)) {
		if (!update) {
			throw new Error(
				`fixture '${opts.fixturePath}' is missing. Re-run with UPDATE_FIXTURES=1 to bootstrap.`,
			);
		}
		mkdirSync(dirname(opts.fixturePath), { recursive: true });
		writeFileSync(opts.fixturePath, actual);
		return;
	}

	const expected = readFileSync(opts.fixturePath, 'utf-8');
	if (actual === expected) return;

	if (update) {
		writeFileSync(opts.fixturePath, actual);
		return;
	}

	throw new Error(
		`upstream CLI changed; review capabilities and update fixture.\nFixture: ${opts.fixturePath}\nRe-run with UPDATE_FIXTURES=1 to overwrite.`,
	);
};
