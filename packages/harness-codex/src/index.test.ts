import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { codex, codexBuildArgs, codexSupports } from './index.ts';

const codexAvailable = (() => {
	const probe = spawnSync('codex', ['--version'], {
		stdio: ['ignore', 'ignore', 'ignore'],
		timeout: 10_000,
	});
	return probe.status === 0;
})();

describe('codex harness', () => {
	it('declares its expected supported modes', () => {
		expect(codex.supports.toSorted()).toEqual(['accept-edits', 'read-only', 'skip']);
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
});
