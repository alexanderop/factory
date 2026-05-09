import * as Reactivity from '@effect/experimental/Reactivity';
import { FileSystem, Path } from '@effect/platform';
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient';
import type { SqlClient } from '@effect/sql/SqlClient';
import { Context, Effect, Layer } from 'effect';
import { installSchema } from '../db/schema.ts';
import { RunRecordingError } from '../errors.ts';
import type { HarnessName, PipelineName, RunId, StepId } from '../ids.ts';
import type { FactoryEvent } from '../types.ts';

export interface RunStartArgs {
	readonly pipeline: PipelineName;
	readonly defaultHarness: HarnessName | undefined;
	readonly cwd: string;
	readonly prdSource: string;
	readonly prdContent: string;
	readonly factoryFile?: string;
}

export interface RunEndArgs {
	readonly status: 'ok' | 'error';
	readonly errorTag?: string;
	readonly errorMessage?: string;
}

export interface StepStartArgs {
	readonly ord: number;
	readonly stepId: StepId;
	readonly source: string;
	readonly harness: HarnessName;
	readonly until: string | undefined;
	readonly maxIters: number;
	readonly stepFileContent: string;
}

export interface StepEndArgs {
	readonly ord: number;
	readonly status: 'ok' | 'failed';
}

export interface IterStartArgs {
	readonly stepOrd: number;
	readonly n: number;
	readonly prompt: string;
}

export interface IterPaths {
	readonly iterDir: string;
	readonly stdoutPath: string;
	readonly stderrPath: string;
	readonly promptPath: string;
}

export interface IterEndArgs {
	readonly stepOrd: number;
	readonly n: number;
	readonly exitCode: number;
	readonly untilPassed?: boolean;
	readonly untilOutput?: string;
	readonly filesChanged?: number;
}

export interface RunWorkspaceService {
	readonly runId: RunId;
	readonly runDir: string;
	readonly dbPath: string;
	readonly recordRunStart: (args: RunStartArgs) => Effect.Effect<void, RunRecordingError>;
	readonly recordRunEnd: (args: RunEndArgs) => Effect.Effect<void, RunRecordingError>;
	readonly recordStepStart: (args: StepStartArgs) => Effect.Effect<void, RunRecordingError>;
	readonly recordStepEnd: (args: StepEndArgs) => Effect.Effect<void, RunRecordingError>;
	readonly recordIterStart: (args: IterStartArgs) => Effect.Effect<IterPaths, RunRecordingError>;
	readonly recordIterEnd: (args: IterEndArgs) => Effect.Effect<void, RunRecordingError>;
	readonly appendEvent: (event: FactoryEvent) => Effect.Effect<void, RunRecordingError>;
	readonly appendStdout: (
		stepOrd: number,
		n: number,
		text: string,
	) => Effect.Effect<void, RunRecordingError>;
	readonly appendStderr: (
		stepOrd: number,
		n: number,
		text: string,
	) => Effect.Effect<void, RunRecordingError>;
}

export class RunWorkspace extends Context.Tag('@factory/RunWorkspace')<
	RunWorkspace,
	RunWorkspaceService
>() {}

const pad = (n: number, width: number): string => n.toString().padStart(width, '0');

const toRecordingError =
	(message: string, path?: string) =>
	(cause: unknown): RunRecordingError =>
		new RunRecordingError({
			message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
			path,
		});

interface MakeServiceArgs {
	readonly runId: RunId;
	readonly runDir: string;
	readonly dbPath: string;
	readonly sql: SqlClient;
	readonly fs: FileSystem.FileSystem;
	readonly path: Path.Path;
}

const iterKey = (stepOrd: number, n: number): string => `${stepOrd}-${n}`;

const makeService = ({
	runId,
	runDir,
	dbPath,
	sql,
	fs,
	path,
}: MakeServiceArgs): RunWorkspaceService => {
	const stepDirsByOrd = new Map<number, string>();
	const iterPathsByKey = new Map<string, IterPaths>();

	const writeFile = (filePath: string, content: string) =>
		fs
			.writeFileString(filePath, content)
			.pipe(Effect.mapError(toRecordingError(`failed to write ${filePath}`, filePath)));

	const ensureDir = (dir: string) =>
		fs
			.makeDirectory(dir, { recursive: true })
			.pipe(Effect.mapError(toRecordingError(`failed to create ${dir}`, dir)));

	const sqlError = (msg: string) => Effect.mapError(toRecordingError(msg, dbPath));

	const appendLog = (kind: 'stdout' | 'stderr', stepOrd: number, n: number, text: string) => {
		const paths = iterPathsByKey.get(iterKey(stepOrd, n));
		if (!paths) {
			return Effect.fail(
				new RunRecordingError({
					message: `cannot append ${kind}: iter ${stepOrd}/${n} not started`,
				}),
			);
		}
		const file = kind === 'stdout' ? paths.stdoutPath : paths.stderrPath;
		return fs
			.writeFileString(file, text, { flag: 'a' })
			.pipe(Effect.mapError(toRecordingError(`failed to append ${kind}`, file)));
	};

	return {
		runId,
		runDir,
		dbPath,

		recordRunStart: (args) =>
			Effect.gen(function* () {
				yield* writeFile(path.join(runDir, 'prd.md'), args.prdContent);
				yield* sql`INSERT INTO run (id, pipeline, default_harness, cwd, prd_source, factory_file, started_at, status)
                   VALUES (${runId}, ${args.pipeline}, ${args.defaultHarness ?? null}, ${args.cwd}, ${args.prdSource}, ${args.factoryFile ?? null}, ${Date.now()}, 'running')`.pipe(
					sqlError('failed to insert run row'),
				);
			}),

		recordRunEnd: (args) =>
			sql`UPDATE run SET ended_at = ${Date.now()}, status = ${args.status}, error_tag = ${args.errorTag ?? null}, error_message = ${args.errorMessage ?? null} WHERE id = ${runId}`.pipe(
				sqlError('failed to update run row'),
				Effect.asVoid,
			),

		recordStepStart: (args) =>
			Effect.gen(function* () {
				const dir = path.join(runDir, 'steps', `${pad(args.ord, 2)}-${args.stepId}`);
				stepDirsByOrd.set(args.ord, dir);
				yield* ensureDir(dir);
				yield* writeFile(path.join(dir, 'step.md'), args.stepFileContent);
				yield* writeFile(
					path.join(dir, 'summary.json'),
					`${JSON.stringify(
						{
							ord: args.ord,
							stepId: args.stepId,
							source: args.source,
							harness: args.harness,
							until: args.until ?? null,
							maxIters: args.maxIters,
						},
						null,
						2,
					)}\n`,
				);
				yield* sql`INSERT INTO step (run_id, ord, step_id, source, harness, until_pred, max_iters, started_at, status)
                   VALUES (${runId}, ${args.ord}, ${args.stepId}, ${args.source}, ${args.harness}, ${args.until ?? null}, ${args.maxIters}, ${Date.now()}, 'running')`.pipe(
					sqlError('failed to insert step row'),
				);
			}),

		recordStepEnd: (args) =>
			sql`UPDATE step SET ended_at = ${Date.now()}, status = ${args.status} WHERE run_id = ${runId} AND ord = ${args.ord}`.pipe(
				sqlError('failed to update step row'),
				Effect.asVoid,
			),

		recordIterStart: (args) =>
			Effect.gen(function* () {
				const stepDir = stepDirsByOrd.get(args.stepOrd);
				if (!stepDir) {
					return yield* Effect.fail(
						new RunRecordingError({
							message: `cannot start iter ${args.stepOrd}/${args.n}: step ${args.stepOrd} not started`,
						}),
					);
				}
				const iterDir = path.join(stepDir, 'iters', pad(args.n, 3));
				yield* ensureDir(iterDir);
				const paths: IterPaths = {
					iterDir,
					stdoutPath: path.join(iterDir, 'stdout.log'),
					stderrPath: path.join(iterDir, 'stderr.log'),
					promptPath: path.join(iterDir, 'prompt.md'),
				};
				iterPathsByKey.set(iterKey(args.stepOrd, args.n), paths);
				yield* writeFile(paths.promptPath, args.prompt);
				yield* sql`INSERT INTO iter (run_id, step_ord, n, started_at) VALUES (${runId}, ${args.stepOrd}, ${args.n}, ${Date.now()})`.pipe(
					sqlError('failed to insert iter row'),
				);
				return paths;
			}),

		recordIterEnd: (args) => {
			const untilPassed = args.untilPassed === undefined ? null : args.untilPassed ? 1 : 0;
			return sql`UPDATE iter SET ended_at = ${Date.now()}, exit_code = ${args.exitCode}, until_passed = ${untilPassed}, until_output = ${args.untilOutput ?? null}, files_changed = ${args.filesChanged ?? null} WHERE run_id = ${runId} AND step_ord = ${args.stepOrd} AND n = ${args.n}`.pipe(
				sqlError('failed to update iter row'),
				Effect.asVoid,
			);
		},

		appendEvent: (event) => {
			const stepId = 'step' in event ? event.step : null;
			const iter = 'iter' in event ? event.iter : null;
			return sql`INSERT INTO event (run_id, ts, type, step_id, iter, payload) VALUES (${runId}, ${Date.now()}, ${event.type}, ${stepId}, ${iter}, ${JSON.stringify(event)})`.pipe(
				sqlError('failed to insert event row'),
				Effect.asVoid,
			);
		},

		appendStdout: (stepOrd, n, text) => appendLog('stdout', stepOrd, n, text),

		appendStderr: (stepOrd, n, text) => appendLog('stderr', stepOrd, n, text),
	};
};

const updateLatestSymlink = (runsDir: string, runId: RunId, fs: FileSystem.FileSystem) => {
	if (process.platform === 'win32') return Effect.void;
	const link = `${runsDir}/latest`;
	return fs
		.remove(link)
		.pipe(Effect.ignore, Effect.zipRight(fs.symlink(runId, link)), Effect.ignore);
};

const buildWorkspace = (
	runId: RunId,
	runDir: string,
	dbPath: string,
	sqliteOpts: Parameters<typeof SqliteClient.make>[0],
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		yield* fs
			.makeDirectory(runDir, { recursive: true })
			.pipe(Effect.mapError(toRecordingError(`failed to create ${runDir}`, runDir)));
		const sql = yield* SqliteClient.make(sqliteOpts).pipe(
			Effect.mapError(toRecordingError(`failed to open SQLite at ${dbPath}`, dbPath)),
		);
		yield* installSchema(sql).pipe(
			Effect.mapError(toRecordingError('failed to install schema', dbPath)),
		);
		return makeService({ runId, runDir, dbPath, sql, fs, path });
	});

interface LiveLayerArgs {
	readonly runId: RunId;
	readonly cwd: string;
}

export const LiveRunWorkspace = {
	layer: (
		args: LiveLayerArgs,
	): Layer.Layer<RunWorkspace, RunRecordingError, FileSystem.FileSystem | Path.Path> =>
		Layer.scoped(
			RunWorkspace,
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const runsDir = path.join(args.cwd, '.factory', 'runs');
				const runDir = path.join(runsDir, args.runId);
				const dbPath = path.join(runDir, 'run.db');
				const service = yield* buildWorkspace(args.runId, runDir, dbPath, { filename: dbPath });
				yield* updateLatestSymlink(runsDir, args.runId, fs);
				return service;
			}),
		).pipe(Layer.provide(Reactivity.layer)),
};

interface InMemoryLayerArgs {
	readonly runId: RunId;
	readonly runDir?: string;
}

/** `:memory:` SQLite + tmp `runDir`; runDir auto-allocated if omitted. */
export const InMemoryRunWorkspace = {
	layer: (
		args: InMemoryLayerArgs,
	): Layer.Layer<RunWorkspace, RunRecordingError, FileSystem.FileSystem | Path.Path> =>
		Layer.scoped(
			RunWorkspace,
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const runDir =
					args.runDir ??
					(yield* fs
						.makeTempDirectoryScoped()
						.pipe(Effect.mapError(toRecordingError('failed to create tmp dir'))));
				return yield* buildWorkspace(args.runId, runDir, ':memory:', {
					filename: ':memory:',
					disableWAL: true,
				});
			}),
		).pipe(Layer.provide(Reactivity.layer)),
};
