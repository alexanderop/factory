import { FileSystem, Path } from '@effect/platform';
import { Clock, Context, Effect, Layer } from 'effect';
import { RunRecordingError } from '../errors.ts';
import type { HarnessName, PipelineName, RunId, StepId } from '../ids.ts';
import type { FactoryEvent } from '../types.ts';
import {
	type IterRecord,
	readRun,
	readStep,
	type RoleRecord,
	type RoleStatus,
	type RunRecord,
	type StepRecord,
	writeIter as writeIterEffect,
	writeRun as writeRunEffect,
	writeStep as writeStepEffect,
} from './runManifest.ts';

export interface RunStartArgs {
	readonly pipeline: PipelineName;
	readonly defaultHarness: HarnessName | undefined;
	readonly cwd: string;
	readonly prdSource: string;
	readonly prdContent: string;
	readonly factoryFile?: string;
}

export interface RunResumeArgs {
	readonly fromStepOrd: number;
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
	readonly eventsPath: string;
}

export interface IterEndArgs {
	readonly stepOrd: number;
	readonly n: number;
	readonly exitCode: number;
	readonly untilPassed?: boolean;
	readonly untilOutput?: string;
	readonly filesChanged?: number;
}

export interface RoleStartArgs {
	readonly stepOrd: number;
	readonly roleId: string;
	readonly harness: HarnessName;
}

export interface RolePaths {
	readonly roleDir: string;
	readonly findingsPath: string;
}

export interface RoleEndArgs {
	readonly stepOrd: number;
	readonly roleId: string;
	readonly status: RoleStatus;
	readonly findings: number;
	readonly errorTag?: string;
}

export interface RunWorkspaceService {
	readonly runId: RunId;
	readonly runDir: string;
	readonly recordRunStart: (args: RunStartArgs) => Effect.Effect<void, RunRecordingError>;
	readonly recordRunResume: (args: RunResumeArgs) => Effect.Effect<RunRecord, RunRecordingError>;
	readonly recordRunEnd: (args: RunEndArgs) => Effect.Effect<void, RunRecordingError>;
	readonly recordStepStart: (args: StepStartArgs) => Effect.Effect<void, RunRecordingError>;
	readonly recordStepEnd: (args: StepEndArgs) => Effect.Effect<void, RunRecordingError>;
	readonly recordIterStart: (args: IterStartArgs) => Effect.Effect<IterPaths, RunRecordingError>;
	readonly recordIterEnd: (args: IterEndArgs) => Effect.Effect<void, RunRecordingError>;
	readonly recordRoleStart: (args: RoleStartArgs) => Effect.Effect<RolePaths, RunRecordingError>;
	readonly recordRoleEnd: (args: RoleEndArgs) => Effect.Effect<void, RunRecordingError>;
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
	readonly appendIterEvent: (
		stepOrd: number,
		n: number,
		event: FactoryEvent,
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

const iterKey = (stepOrd: number, n: number): string => `${stepOrd}-${n}`;

interface StepEntry {
	readonly dir: string;
	readonly path: string;
	record: StepRecord;
}

interface MakeServiceArgs {
	readonly runId: RunId;
	readonly runDir: string;
	readonly fs: FileSystem.FileSystem;
	readonly path: Path.Path;
	readonly hydrated?: {
		readonly runRecord: RunRecord;
		readonly stepEntries: ReadonlyArray<StepEntry>;
	};
}

const makeService = ({
	runId,
	runDir,
	fs,
	path,
	hydrated,
}: MakeServiceArgs): RunWorkspaceService => {
	const stepEntries = new Map<number, StepEntry>();
	const iterPathsByKey = new Map<string, IterPaths>();
	const runPath = path.join(runDir, 'run.json');
	const eventsPath = path.join(runDir, 'events.jsonl');
	// Roles fan out concurrently — serialise persistence to keep the
	// read-modify-write of `entry.record.roles` atomic and avoid clobbering
	// the per-step `step.json.tmp.<pid>` file from parallel fibers.
	const roleMutex = Effect.unsafeMakeSemaphore(1);
	let runRecord: RunRecord | undefined = hydrated?.runRecord;
	if (hydrated) {
		for (const entry of hydrated.stepEntries) {
			stepEntries.set(entry.record.ord, entry);
		}
	}

	const provideFs = Effect.provideService(FileSystem.FileSystem, fs);
	const writeRun = (p: string, value: RunRecord) => writeRunEffect(p, value).pipe(provideFs);
	const writeStep = (p: string, value: StepRecord) => writeStepEffect(p, value).pipe(provideFs);
	const writeIter = (p: string, value: IterRecord) => writeIterEffect(p, value).pipe(provideFs);

	const ensureDir = (dir: string) =>
		fs
			.makeDirectory(dir, { recursive: true })
			.pipe(Effect.mapError(toRecordingError(`failed to create ${dir}`, dir)));

	const writeFile = (filePath: string, content: string) =>
		fs
			.writeFileString(filePath, content)
			.pipe(Effect.mapError(toRecordingError(`failed to write ${filePath}`, filePath)));

	const appendLine = (filePath: string, line: string) =>
		fs
			.writeFileString(filePath, `${line}\n`, { flag: 'a' })
			.pipe(Effect.mapError(toRecordingError(`failed to append ${filePath}`, filePath)));

	const requireRun = (): Effect.Effect<RunRecord, RunRecordingError> =>
		runRecord === undefined
			? Effect.fail(
					new RunRecordingError({
						message: 'run not started; call recordRunStart first',
						path: runPath,
					}),
				)
			: Effect.succeed(runRecord);

	const persistStep = (entry: StepEntry) => writeStep(entry.path, entry.record);

	const requireStep = (ord: number, op: string): Effect.Effect<StepEntry, RunRecordingError> => {
		const entry = stepEntries.get(ord);
		return entry === undefined
			? Effect.fail(
					new RunRecordingError({
						message: `cannot ${op}: step ${ord} not started`,
					}),
				)
			: Effect.succeed(entry);
	};

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

		recordRunStart: (args) =>
			Effect.gen(function* () {
				yield* writeFile(path.join(runDir, 'prd.md'), args.prdContent);
				const startedAt = yield* Clock.currentTimeMillis;
				const record: RunRecord = {
					id: runId,
					pipeline: args.pipeline,
					...(args.defaultHarness === undefined ? {} : { defaultHarness: args.defaultHarness }),
					cwd: args.cwd,
					prdSource: args.prdSource,
					...(args.factoryFile === undefined ? {} : { factoryFile: args.factoryFile }),
					startedAt,
					status: 'running',
				};
				runRecord = record;
				yield* writeRun(runPath, record);
			}),

		recordRunResume: (args) =>
			Effect.gen(function* () {
				const current = yield* requireRun();
				const next: RunRecord = {
					id: current.id,
					pipeline: current.pipeline,
					...(current.defaultHarness === undefined
						? {}
						: { defaultHarness: current.defaultHarness }),
					cwd: current.cwd,
					prdSource: current.prdSource,
					...(current.factoryFile === undefined ? {} : { factoryFile: current.factoryFile }),
					startedAt: current.startedAt,
					status: 'running',
				};
				runRecord = next;
				yield* writeRun(runPath, next);
				yield* Effect.logDebug(`run resumed from step ord ${args.fromStepOrd}`);
				return next;
			}),

		recordRunEnd: (args) =>
			Effect.gen(function* () {
				const current = yield* requireRun();
				const endedAt = yield* Clock.currentTimeMillis;
				const updated: RunRecord = {
					...current,
					endedAt,
					status: args.status,
					...(args.errorTag === undefined ? {} : { errorTag: args.errorTag }),
					...(args.errorMessage === undefined ? {} : { errorMessage: args.errorMessage }),
				};
				runRecord = updated;
				yield* writeRun(runPath, updated);
			}),

		recordStepStart: (args) =>
			Effect.gen(function* () {
				const dir = path.join(runDir, 'steps', `${pad(args.ord, 2)}-${args.stepId}`);
				yield* ensureDir(dir);
				yield* writeFile(path.join(dir, 'step.md'), args.stepFileContent);
				const startedAt = yield* Clock.currentTimeMillis;
				const record: StepRecord = {
					ord: args.ord,
					stepId: args.stepId,
					source: args.source,
					harness: args.harness,
					...(args.until === undefined ? {} : { until: args.until }),
					maxIters: args.maxIters,
					startedAt,
					status: 'running',
					iters: [],
				};
				const entry: StepEntry = { dir, path: path.join(dir, 'step.json'), record };
				stepEntries.set(args.ord, entry);
				yield* persistStep(entry);
			}),

		recordStepEnd: (args) =>
			Effect.gen(function* () {
				const entry = yield* requireStep(args.ord, 'end step');
				const endedAt = yield* Clock.currentTimeMillis;
				entry.record = { ...entry.record, endedAt, status: args.status };
				yield* persistStep(entry);
			}),

		recordIterStart: (args) =>
			Effect.gen(function* () {
				const entry = yield* requireStep(args.stepOrd, `start iter ${args.stepOrd}/${args.n}`);
				const iterDir = path.join(entry.dir, 'iters', pad(args.n, 3));
				yield* ensureDir(iterDir);
				const paths: IterPaths = {
					iterDir,
					stdoutPath: path.join(iterDir, 'stdout.log'),
					stderrPath: path.join(iterDir, 'stderr.log'),
					promptPath: path.join(iterDir, 'prompt.md'),
					eventsPath: path.join(iterDir, 'events.jsonl'),
				};
				iterPathsByKey.set(iterKey(args.stepOrd, args.n), paths);
				yield* writeFile(paths.promptPath, args.prompt);
				const startedAt = yield* Clock.currentTimeMillis;
				const iter: IterRecord = { n: args.n, startedAt };
				entry.record = { ...entry.record, iters: [...entry.record.iters, iter] };
				yield* persistStep(entry);
				return paths;
			}),

		recordIterEnd: (args) =>
			Effect.gen(function* () {
				const entry = yield* requireStep(args.stepOrd, `end iter ${args.stepOrd}/${args.n}`);
				const idx = entry.record.iters.findIndex((it) => it.n === args.n);
				const existing = idx < 0 ? undefined : entry.record.iters[idx];
				if (existing === undefined) {
					return yield* Effect.fail(
						new RunRecordingError({
							message: `cannot end iter ${args.stepOrd}/${args.n}: iter not started`,
						}),
					);
				}
				const endedAt = yield* Clock.currentTimeMillis;
				const updatedIter: IterRecord = {
					...existing,
					n: args.n,
					endedAt,
					exitCode: args.exitCode,
					...(args.untilPassed === undefined ? {} : { untilPassed: args.untilPassed }),
					...(args.untilOutput === undefined ? {} : { untilOutput: args.untilOutput }),
					...(args.filesChanged === undefined ? {} : { filesChanged: args.filesChanged }),
				};
				const iters = entry.record.iters.map((it, i) => (i === idx ? updatedIter : it));
				entry.record = { ...entry.record, iters };
				yield* persistStep(entry);

				const iterPaths = iterPathsByKey.get(iterKey(args.stepOrd, args.n));
				if (iterPaths) {
					yield* writeIter(path.join(iterPaths.iterDir, 'summary.json'), updatedIter);
				}
			}),

		recordRoleStart: (args) =>
			roleMutex.withPermits(1)(
				Effect.gen(function* () {
					const entry = yield* requireStep(
						args.stepOrd,
						`start role ${args.stepOrd}/${args.roleId}`,
					);
					const roleDir = path.join(entry.dir, 'roles', args.roleId);
					yield* ensureDir(roleDir);
					const findingsPath = path.join(roleDir, 'findings.json');
					const startedAt = yield* Clock.currentTimeMillis;
					const role: RoleRecord = {
						name: args.roleId,
						harness: args.harness,
						startedAt,
						status: 'running',
						findings: 0,
					};
					const existing = entry.record.roles ?? [];
					const roles = existing.concat(role);
					entry.record = { ...entry.record, roles };
					yield* persistStep(entry);
					return { roleDir, findingsPath } satisfies RolePaths;
				}),
			),

		recordRoleEnd: (args) =>
			roleMutex.withPermits(1)(
				Effect.gen(function* () {
					const entry = yield* requireStep(args.stepOrd, `end role ${args.stepOrd}/${args.roleId}`);
					const existing = entry.record.roles ?? [];
					const next = existing.slice();
					let idx = -1;
					for (let i = 0; i < next.length; i++) {
						if (next[i]?.name === args.roleId) {
							idx = i;
							break;
						}
					}
					const current = idx < 0 ? undefined : next[idx];
					if (current === undefined) {
						return yield* Effect.fail(
							new RunRecordingError({
								message: `cannot end role ${args.stepOrd}/${args.roleId}: role not started`,
							}),
						);
					}
					const endedAt = yield* Clock.currentTimeMillis;
					next[idx] = {
						name: current.name,
						harness: current.harness,
						startedAt: current.startedAt,
						endedAt,
						status: args.status,
						findings: args.findings,
						...(args.errorTag === undefined ? {} : { errorTag: args.errorTag }),
					};
					entry.record = { ...entry.record, roles: next };
					yield* persistStep(entry);
				}),
			),

		appendEvent: (event) => appendLine(eventsPath, JSON.stringify(event)),

		appendStdout: (stepOrd, n, text) => appendLog('stdout', stepOrd, n, text),

		appendStderr: (stepOrd, n, text) => appendLog('stderr', stepOrd, n, text),

		appendIterEvent: (stepOrd, n, event) => {
			const paths = iterPathsByKey.get(iterKey(stepOrd, n));
			if (!paths) {
				return Effect.fail(
					new RunRecordingError({
						message: `cannot append iter event: iter ${stepOrd}/${n} not started`,
					}),
				);
			}
			return appendLine(paths.eventsPath, JSON.stringify(event));
		},
	};
};

const updateLatestSymlink = (runsDir: string, runId: RunId, fs: FileSystem.FileSystem) => {
	if (process.platform === 'win32') return Effect.void;
	const link = `${runsDir}/latest`;
	const logRemoveFail = Effect.catchAll((cause: unknown) =>
		Effect.logDebug(`updateLatestSymlink: remove(${link}) failed (likely missing)`, cause),
	);
	const logSymlinkFail = Effect.catchAll((cause: unknown) =>
		Effect.logDebug(`updateLatestSymlink: symlink(${runId} -> ${link}) failed`, cause),
	);
	return fs
		.remove(link)
		.pipe(logRemoveFail, Effect.zipRight(fs.symlink(runId, link)), logSymlinkFail);
};

const buildWorkspace = (runId: RunId, runDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		yield* fs
			.makeDirectory(runDir, { recursive: true })
			.pipe(Effect.mapError(toRecordingError(`failed to create ${runDir}`, runDir)));
		return makeService({ runId, runDir, fs, path });
	});

const hydrateStepEntries = (runDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const stepsRoot = path.join(runDir, 'steps');
		const exists = yield* fs
			.exists(stepsRoot)
			.pipe(Effect.mapError(toRecordingError(`failed to stat ${stepsRoot}`, stepsRoot)));
		const empty: ReadonlyArray<StepEntry> = [];
		if (!exists) return empty;
		const subdirs = yield* fs
			.readDirectory(stepsRoot)
			.pipe(Effect.mapError(toRecordingError(`failed to read ${stepsRoot}`, stepsRoot)));
		const entries: StepEntry[] = [];
		for (const name of subdirs) {
			const dir = path.join(stepsRoot, name);
			const stepJsonPath = path.join(dir, 'step.json');
			const has = yield* fs
				.exists(stepJsonPath)
				.pipe(Effect.mapError(toRecordingError(`failed to stat ${stepJsonPath}`, stepJsonPath)));
			if (!has) continue;
			const record = yield* readStep(stepJsonPath);
			entries.push({ dir, path: stepJsonPath, record });
		}
		const sorted: ReadonlyArray<StepEntry> = entries.toSorted(
			(a, b) => a.record.ord - b.record.ord,
		);
		return sorted;
	});

const buildResumedWorkspace = (runId: RunId, runDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const runJsonPath = path.join(runDir, 'run.json');
		const runRecord = yield* readRun(runJsonPath);
		const stepEntries = yield* hydrateStepEntries(runDir);
		return makeService({
			runId,
			runDir,
			fs,
			path,
			hydrated: { runRecord, stepEntries },
		});
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
				const service = yield* buildWorkspace(args.runId, runDir);
				yield* updateLatestSymlink(runsDir, args.runId, fs);
				return service;
			}),
		),

	resumed: (
		args: LiveLayerArgs,
	): Layer.Layer<RunWorkspace, RunRecordingError, FileSystem.FileSystem | Path.Path> =>
		Layer.scoped(
			RunWorkspace,
			Effect.gen(function* () {
				const path = yield* Path.Path;
				const runsDir = path.join(args.cwd, '.factory', 'runs');
				const runDir = path.join(runsDir, args.runId);
				return yield* buildResumedWorkspace(args.runId, runDir);
			}),
		),
};

interface InMemoryLayerArgs {
	readonly runId: RunId;
	readonly runDir?: string;
}

/** Tmp-dir-backed workspace; runDir auto-allocated and scoped if omitted. */
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
						.makeTempDirectoryScoped({ prefix: 'factory-ws-' })
						.pipe(Effect.mapError(toRecordingError('failed to create tmp dir'))));
				return yield* buildWorkspace(args.runId, runDir);
			}),
		),
};
