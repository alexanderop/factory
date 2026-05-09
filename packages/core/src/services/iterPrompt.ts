import { FileSystem, Path } from '@effect/platform';
import { Chunk, Effect, Stream } from 'effect';
import { RunRecordingError } from '../errors.ts';
import type { StepId } from '../ids.ts';
import { type IterRecord, readIter } from './runManifest.ts';

const STDOUT_TAIL_LINES = 200;

const pad = (n: number, width: number): string => n.toString().padStart(width, '0');

const toRecordingError =
	(message: string, path?: string) =>
	(cause: unknown): RunRecordingError =>
		new RunRecordingError({
			message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
			path,
		});

const tail = (path: string, n: number) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const exists = yield* fs
			.exists(path)
			.pipe(Effect.mapError(toRecordingError('failed to stat', path)));
		if (!exists) return '';
		return yield* fs.stream(path).pipe(
			Stream.decodeText(),
			Stream.splitLines,
			Stream.runCollect,
			Effect.map((chunk) => Chunk.toReadonlyArray(chunk).slice(-n).join('\n')),
			Effect.mapError(toRecordingError('failed to read stdout tail', path)),
		);
	});

export interface BuildIterPromptArgs {
	readonly runDir: string;
	readonly stepOrd: number;
	readonly stepId: StepId;
	readonly previousIter: number;
	readonly basePrompt: string;
}

const formatLastAttempt = (iter: IterRecord, stdoutTail: string): string => {
	const lines = [
		`# Last attempt`,
		``,
		`- iter: ${iter.n}`,
		`- exitCode: ${iter.exitCode ?? 'n/a'}`,
	];
	if (iter.untilPassed !== undefined) {
		lines.push(`- untilPassed: ${iter.untilPassed}`);
	}
	if (iter.untilOutput !== undefined && iter.untilOutput.length > 0) {
		lines.push(``, `## until output`, ``, '```', iter.untilOutput, '```');
	}
	if (stdoutTail.length > 0) {
		lines.push(``, `## stdout (tail)`, ``, '```', stdoutTail, '```');
	}
	return lines.join('\n');
};

export const buildIterPrompt = (
	args: BuildIterPromptArgs,
): Effect.Effect<string, RunRecordingError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		if (args.previousIter < 1) return args.basePrompt;
		const path = yield* Path.Path;
		const stepDir = path.join(args.runDir, 'steps', `${pad(args.stepOrd, 2)}-${args.stepId}`);
		const iterDir = path.join(stepDir, 'iters', pad(args.previousIter, 3));
		const summaryPath = path.join(iterDir, 'summary.json');
		const fs = yield* FileSystem.FileSystem;
		const summaryExists = yield* fs
			.exists(summaryPath)
			.pipe(Effect.mapError(toRecordingError('failed to stat', summaryPath)));
		if (!summaryExists) return args.basePrompt;
		const iter = yield* readIter(summaryPath);
		const stdoutPath = path.join(iterDir, 'stdout.log');
		const stdoutTail = yield* tail(stdoutPath, STDOUT_TAIL_LINES).pipe(
			Effect.catchAll(() => Effect.succeed('')),
		);
		const header = formatLastAttempt(iter, stdoutTail);
		return `${header}\n\n${args.basePrompt}`;
	});
