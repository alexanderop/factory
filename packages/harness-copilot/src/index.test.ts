import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { copilot, copilotBuildArgs, copilotSupports } from './index.ts';

const copilotAvailable = (() => {
	const probe = spawnSync('copilot', ['--version'], {
		stdio: ['ignore', 'ignore', 'ignore'],
		timeout: 10_000,
	});
	return probe.status === 0;
})();

describe('copilot harness', () => {
	it('declares its expected supported modes', () => {
		expect(copilot.supports.toSorted()).toEqual(['accept-edits', 'skip']);
	});

	it('defaults to skip', () => {
		expect(copilot.defaultPermissions).toBe('skip');
	});

	it.skipIf(!copilotAvailable)('every emitted permission flag set is accepted by `copilot`', () => {
		for (const mode of copilotSupports) {
			const args = copilotBuildArgs('test', { permissions: mode });
			const result = spawnSync('copilot', [...args, '--help'], {
				stdio: ['ignore', 'ignore', 'pipe'],
				timeout: 10_000,
				encoding: 'utf-8',
			});
			expect(result.status, `mode=${mode} args=${args.join(' ')} stderr=${result.stderr}`).toBe(0);
		}
	});
});
