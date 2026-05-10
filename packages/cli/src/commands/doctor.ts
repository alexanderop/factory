import { Args, Command, Options } from '@effect/cli';
import { Path } from '@effect/platform';
import { Effect, Option } from 'effect';
import { authKindStr, type Harness } from '@factory/core';
import { loadFactoryConfig } from '../loadConfig.ts';

const checkMark = (name: string): string => (name in process.env ? '✓' : '✗');

const formatHarness = (harness: Harness): string => {
	const lines: string[] = [];
	lines.push(`harness: ${harness.name}`);
	lines.push(`auth: ${authKindStr(harness.currentAuth)}`);

	if (harness.auth.envVars.length > 0) {
		lines.push('');
		lines.push('env vars (precedence order):');
		for (const v of harness.auth.envVars) {
			lines.push(`  ${checkMark(v.name)} ${v.name} (${v.kind})`);
		}
	}

	if (harness.auth.extraEnv && harness.auth.extraEnv.length > 0) {
		lines.push('');
		lines.push('extra env:');
		for (const v of harness.auth.extraEnv) {
			lines.push(`  ${checkMark(v.name)} ${v.name}`);
		}
	}

	const hasApiKey = harness.auth.envVars.some((v) => v.kind === 'api-key');
	if (!hasApiKey && harness.auth.envVars.length > 0) {
		lines.push('');
		lines.push(
			'note: requires a seat subscription — listed tokens are a transport, not a substitute',
		);
	}

	return lines.join('\n');
};

export const formatDoctorReport = (harnesses: ReadonlyArray<Harness>): string => {
	if (harnesses.length === 0) return '(no harnesses configured)';
	return harnesses.map(formatHarness).join('\n\n');
};

const nameArg = Args.text({ name: 'name' }).pipe(
	Args.withDescription(
		'Name of the factory pipeline to inspect (matches factory({name}) in your config)',
	),
);

const cwdOption = Options.directory('cwd').pipe(
	Options.withDescription('Working directory (default: process.cwd())'),
	Options.optional,
);

export const doctorCommand = Command.make(
	'doctor',
	{ name: nameArg, cwd: cwdOption },
	({ name, cwd: cwdOpt }) =>
		Effect.gen(function* () {
			const path = yield* Path.Path;
			const cwd = Option.getOrUndefined(cwdOpt) ?? path.resolve(process.cwd());
			const factoryDef = yield* loadFactoryConfig(cwd, name);
			const report = formatDoctorReport(factoryDef.harnesses);
			yield* Effect.sync(() => console.log(report));
		}),
);
