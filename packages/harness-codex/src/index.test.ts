import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { assertHelpSnapshot } from '@factory/core/testing';
import { describe, expect, it } from 'vitest';
import { codex, codexBuildArgs, codexSupports } from './index.ts';

const codexAvailable = (() => {
	const probe = spawnSync('codex', ['--version'], {
		stdio: ['ignore', 'ignore', 'ignore'],
		timeout: 10_000,
	});
	return probe.status === 0;
})();

const helpFixture = join(import.meta.dirname, '..', '__fixtures__', 'help.txt');
const live = process.env.HARNESS_LIVE === '1';

describe('codex harness', () => {
	it('declares its expected supported modes', () => {
		expect(codex.capabilities.factory.permissions.toSorted()).toEqual([
			'accept-edits',
			'read-only',
			'skip',
		]);
	});

	it('defaults to skip', () => {
		expect(codex.defaultPermissions).toBe('skip');
	});

	it.skipIf(!codexAvailable)('every emitted permission flag set is accepted by `codex`', () => {
		for (const mode of codexSupports) {
			const args = codexBuildArgs('test', { permissions: mode });
			const result = spawnSync('codex', [...args, '--help'], {
				stdio: ['ignore', 'ignore', 'pipe'],
				timeout: 10_000,
				encoding: 'utf-8',
			});
			expect(result.status, `mode=${mode} args=${args.join(' ')} stderr=${result.stderr}`).toBe(0);
		}
	});

	it.skipIf(!live)('codex --help matches snapshot fixture', () => {
		assertHelpSnapshot({ bin: 'codex', fixturePath: helpFixture });
	});
});
