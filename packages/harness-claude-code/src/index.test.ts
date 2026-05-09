import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { assertHelpSnapshot } from '@factory/core/testing';
import { describe, expect, it } from 'vitest';
import { claudeBuildArgs, claudeCode, claudeSupports } from './index.ts';

const claudeAvailable = (() => {
	const probe = spawnSync('claude', ['--version'], {
		stdio: ['ignore', 'ignore', 'ignore'],
		timeout: 10_000,
	});
	return probe.status === 0;
})();

const helpFixture = join(import.meta.dirname, '..', '__fixtures__', 'help.txt');
const live = process.env.HARNESS_LIVE === '1';

describe('claude-code harness', () => {
	it('declares its expected supported modes', () => {
		expect(claudeCode.capabilities.factory.permissions.toSorted()).toEqual([
			'accept-edits',
			'prompt',
			'read-only',
			'skip',
		]);
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

	it.skipIf(!live)('claude --help matches snapshot fixture', () => {
		assertHelpSnapshot({ bin: 'claude', fixturePath: helpFixture });
	});
});
