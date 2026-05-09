import { FileSystem, Path } from '@effect/platform';
import { NodeContext } from '@effect/platform-node';
import { describe, it } from '@effect/vitest';
import { assertTrue, strictEqual } from '@effect/vitest/utils';
import { Effect } from 'effect';
import { StepId } from './ids.ts';
import { buildIterPrompt } from './services/iterPrompt.ts';
import { writeIter } from './services/runManifest.ts';

describe('buildIterPrompt', () => {
	it.scoped('returns the base prompt unchanged on the first iteration', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-iterprompt-' });
			const result = yield* buildIterPrompt({
				runDir,
				stepOrd: 0,
				stepId: StepId.make('plan'),
				previousIter: 0,
				basePrompt: '# PRD\n\nbody',
			});
			strictEqual(result, '# PRD\n\nbody');
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('prepends a "Last attempt" section with stdout tail and exit code', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-iterprompt-' });
			const stepDir = path.join(runDir, 'steps', '00-plan');
			const iterDir = path.join(stepDir, 'iters', '001');
			yield* fs.makeDirectory(iterDir, { recursive: true });
			yield* writeIter(path.join(iterDir, 'summary.json'), {
				n: 1,
				startedAt: 1,
				endedAt: 2,
				exitCode: 7,
				untilPassed: false,
				untilOutput: 'tests failed',
			});
			yield* fs.writeFileString(
				path.join(iterDir, 'stdout.log'),
				['line-1', 'line-2', 'line-3'].join('\n'),
			);

			const result = yield* buildIterPrompt({
				runDir,
				stepOrd: 0,
				stepId: StepId.make('plan'),
				previousIter: 1,
				basePrompt: 'BASE',
			});

			assertTrue(result.startsWith('# Last attempt'));
			assertTrue(result.includes('exitCode: 7'));
			assertTrue(result.includes('untilPassed: false'));
			assertTrue(result.includes('tests failed'));
			assertTrue(result.includes('line-1'));
			assertTrue(result.includes('line-3'));
			assertTrue(result.endsWith('\n\nBASE'));
		}).pipe(Effect.provide(NodeContext.layer)),
	);

	it.scoped('falls back to base prompt when summary.json is missing', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const runDir = yield* fs.makeTempDirectoryScoped({ prefix: 'factory-iterprompt-' });
			const result = yield* buildIterPrompt({
				runDir,
				stepOrd: 0,
				stepId: StepId.make('plan'),
				previousIter: 1,
				basePrompt: 'BASE',
			});
			strictEqual(result, 'BASE');
		}).pipe(Effect.provide(NodeContext.layer)),
	);
});
