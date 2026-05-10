import { join } from 'node:path';
import { factory } from '@factory/core';
import { assertHelpSnapshot, scriptedHarness } from '@factory/core/testing';
import { describe, expect, it } from 'vitest';
import { formatDoctorReport } from './doctor.ts';

const live = process.env.FACTORY_LIVE === '1';
const helpFixture = join(import.meta.dirname, '..', '..', '__fixtures__', 'doctor-help.txt');
const mainTs = join(import.meta.dirname, '..', 'main.ts');

describe('doctor command', () => {
	it.skipIf(!live)('factory doctor --help matches snapshot', () => {
		assertHelpSnapshot({
			bin: 'tsx',
			fixturePath: helpFixture,
			args: [mainTs, 'doctor', '--help'],
		});
	});

	it('prints harness name, auth variant, and env var presence', () => {
		const h = scriptedHarness('test-harness', [], {
			authSpec: {
				envVars: [{ name: 'TEST_DOCTOR_KEY', kind: 'api-key', description: 'Test key' }],
			},
		});
		const factoryDef = factory({ name: 'test', harnesses: [h] });
		const output = formatDoctorReport(factoryDef.harnesses);
		expect(output).toContain('test-harness');
		expect(output).toContain('inherit');
		expect(output).toContain('TEST_DOCTOR_KEY');
		expect(output).toMatch(/[✓✗] TEST_DOCTOR_KEY/);
	});
});
