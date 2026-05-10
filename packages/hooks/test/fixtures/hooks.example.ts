import { Effect } from 'effect';
import { Hook } from '../../src/builders.ts';

export const exampleSpecs = [
	Hook.denyPaths(['**/.env*', '**/.secret*']),
	Hook.denyCommands(['rm -rf', 'git push --force']),
	Hook.formatOnWrite({ run: 'prettier --write' }),
	Hook.auditLog({ to: 'audit.log' }),
	Hook.rule({ on: 'preToolUse', decide: 'allow' }),
	Hook.effect({
		on: 'preToolUse',
		handler: () => Effect.succeed(Hook.deny('blocked by custom handler')),
	}),
];
