import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { claudeBuildArgs, claudeCode, claudeSupports } from './index.ts';

const claudeAvailable = (() => {
	const probe = spawnSync('claude', ['--version'], {
		stdio: ['ignore', 'ignore', 'ignore'],
		timeout: 10_000,
	});
	return probe.status === 0;
})();

describe('claude-code harness', () => {
	it('declares its expected supported modes', () => {
		expect(claudeCode.supports.toSorted()).toEqual(['accept-edits', 'prompt', 'read-only', 'skip']);
	});

	it('defaults to skip', () => {
		expect(claudeCode.defaultPermissions).toBe('skip');
	});

	it.skipIf(!claudeAvailable)('every emitted permission flag set is accepted by `claude`', () => {
		for (const mode of claudeSupports) {
			const args = claudeBuildArgs('test', { permissions: mode });
			const result = spawnSync('claude', [...args, '--help'], {
				stdio: ['ignore', 'ignore', 'pipe'],
				timeout: 10_000,
				encoding: 'utf-8',
			});
			expect(result.status, `mode=${mode} args=${args.join(' ')} stderr=${result.stderr}`).toBe(0);
		}
	});
});
