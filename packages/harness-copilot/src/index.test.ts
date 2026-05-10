import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { assertHelpSnapshot } from '@factory/core/testing';
import { describe, expect, it } from 'vitest';
import { copilot, copilotBuildArgs, copilotSupports } from './index.ts';

const copilotAvailable = (() => {
	const probe = spawnSync('copilot', ['--version'], {
		stdio: ['ignore', 'ignore', 'ignore'],
		timeout: 10_000,
	});
	return probe.status === 0;
})();

const helpFixture = join(import.meta.dirname, '..', '__fixtures__', 'help.txt');
const live = process.env.HARNESS_LIVE === '1';

describe('copilot harness', () => {
	it('declares an auth spec', () => {
		expect(copilot.auth.envVars.map(({ name, kind }) => ({ name, kind }))).toEqual([
			{ name: 'GH_TOKEN', kind: 'pat' },
			{ name: 'GITHUB_TOKEN', kind: 'pat' },
		]);
		expect(copilot.auth.envVars.some((v) => v.kind === 'api-key')).toBe(false);
		expect(copilot.auth.extraEnv).toBeUndefined();
	});

	it('declares its expected supported modes', () => {
		expect(copilot.capabilities.factory.permissions.toSorted()).toEqual(['accept-edits', 'skip']);
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

	it.skipIf(!live)('copilot --help matches snapshot fixture', () => {
		assertHelpSnapshot({ bin: 'copilot', fixturePath: helpFixture });
	});
});
