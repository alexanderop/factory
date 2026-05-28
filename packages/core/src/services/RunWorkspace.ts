import { FileSystem, Path } from '@effect/platform';
import { Clock, Context, Effect, Layer, Ref } from 'effect';
import { RunRecordingError } from '../errors.ts';
import {
	type AgentLabel,
	type AgentSeq,
	agentDirName,
	type HarnessName,
	type PipelineName,
	type RunId,
	type StepId,
} from '../ids.ts';
import type { FactoryEvent } from '../types.ts';
import {
	type AgentRecord,
	type IterRecord,
	readAgent,
	readRun,
	readStep,
	type RoleRecord,
	type RoleStatus,
	type RunRecord,
	type StepRecord,
	type StepStatus,
	writeAgent as writeAgentEffect,
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
	/** Where the harness writes structured output when `$FACTORY_STEP_OUTPUT` is
	 *  set (programmatic `agent({ schema })`). Populated for every iter dir. */
	readonly outputPath: string;
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

export interface AgentStartArgs {
	readonly seq: AgentSeq;
	readonly label: AgentLabel;
	readonly promptHash: string;
	readonly optsHash: string;
	readonly harness: HarnessName;
}

export interface AgentIterStartArgs {
	readonly seq: AgentSeq;
	readonly n: number;
	readonly prompt: string;
}

export interface AgentIterEndArgs {
	readonly seq: AgentSeq;
	readonly n: number;
	readonly exitCode: number;
}

export interface AgentEndArgs {
	readonly seq: AgentSeq;
	readonly status: StepStatus;
	readonly output?: unknown;
}

/** An agent recorded as `'ok'` whose `(promptHash, optsHash)` match the current
 *  call — eligible for resume short-circuit. */
export interface ResumableAgent {
	readonly record: AgentRecord;
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
	// ---- programmatic agent() layout (agents/<seq>-<label>/), additive ----
	readonly recordAgentStart: (args: AgentStartArgs) => Effect.Effect<void, RunRecordingError>;
	readonly recordAgentIterStart: (
		args: AgentIterStartArgs,
	) => Effect.Effect<IterPaths, RunRecordingError>;
	readonly recordAgentIterEnd: (args: AgentIterEndArgs) => Effect.Effect<void, RunRecordingError>;
	readonly recordAgentEnd: (args: AgentEndArgs) => Effect.Effect<void, RunRecordingError>;
	readonly appendAgentStdout: (
		seq: AgentSeq,
		n: number,
		text: string,
	) => Effect.Effect<void, RunRecordingError>;
	readonly appendAgentStderr: (
		seq: AgentSeq,
		n: number,
		text: string,
	) => Effect.Effect<void, RunRecordingError>;
	readonly appendAgentIterEvent: (
		seq: AgentSeq,
		n: number,
		event: FactoryEvent,
	) => Effect.Effect<void, RunRecordingError>;
	/** Resume short-circuit lookup: returns the recorded agent at `seq` iff it
	 *  completed `'ok'` and its hashes match — otherwise `undefined` (re-run). */
	readonly findResumableAgent: (
		seq: AgentSeq,
		promptHash: string,
		optsHash: string,
	) => Effect.Effect<ResumableAgent | undefined, RunRecordingError>;
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
const agentIterKey = (seq: number, n: number): string => `agent-${seq}-${n}`;

interface StepEntry {
	readonly dir: string;
	readonly path: string;
	readonly record: StepRecord;
}

interface AgentEntry {
	readonly dir: string;
	readonly path: string;
	readonly record: AgentRecord;
}

interface MakeServiceArgs {
	readonly runId: RunId;
	readonly runDir: string;
	readonly fs: FileSystem.FileSystem;
	readonly path: Path.Path;
	readonly hydrated?: {
		readonly runRecord: RunRecord;
		readonly stepEntries: ReadonlyArray<StepEntry>;
		readonly agentEntries?: ReadonlyArray<AgentEntry>;
	};
}

const makeService = ({
	runId,
	runDir,
	fs,
	path,
	hydrated,
}: MakeServiceArgs): Effect.Effect<RunWorkspaceService> =>
	Effect.gen(function* () {
		const runPath = path.join(runDir, 'run.json');
		const eventsPath = path.join(runDir, 'events.jsonl');

		// Roles fan out concurrently — serialise persistence so the per-step
		// read-modify-write-and-disk-write is atomic and parallel fibers don't
		// clobber the same `step.json.tmp.<pid>` file. `Effect.makeSemaphore`
		// (vs. `unsafeMakeSemaphore`) keeps allocation inside the Effect
		// runtime so it composes with finalizers and tracing.
		const roleMutex = yield* Effect.makeSemaphore(1);
		// `Ref` for state instead of `let` + mutable Maps so concurrent writes
		// go through a serialisable update primitive rather than relying on
		// JS's lack of preemption between statements.
		const runRecordRef = yield* Ref.make<RunRecord | undefined>(hydrated?.runRecord);
		const stepEntriesRef = yield* Ref.make<ReadonlyMap<number, StepEntry>>(
			new Map(hydrated?.stepEntries.map((e) => [e.record.ord, e] as const) ?? []),
		);
		// Dedicated map for the programmatic agent layout — never reuse
		// stepEntriesRef so the declarative path can't be clobbered.
		const agentEntriesRef = yield* Ref.make<ReadonlyMap<number, AgentEntry>>(
			new Map(hydrated?.agentEntries?.map((e) => [e.record.seq, e] as const) ?? []),
		);
		const iterPathsRef = yield* Ref.make<ReadonlyMap<string, IterPaths>>(new Map());

		const provideFs = Effect.provideService(FileSystem.FileSystem, fs);
		const writeRun = (p: string, value: RunRecord) => writeRunEffect(p, value).pipe(provideFs);
		const writeStep = (p: string, value: StepRecord) => writeStepEffect(p, value).pipe(provideFs);
		const writeIter = (p: string, value: IterRecord) => writeIterEffect(p, value).pipe(provideFs);
		const writeAgent = (p: string, value: AgentRecord) =>
			writeAgentEffect(p, value).pipe(provideFs);

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
			Ref.get(runRecordRef).pipe(
				Effect.flatMap((current) =>
					current === undefined
						? Effect.fail(
								new RunRecordingError({
									message: 'run not started; call recordRunStart first',
									path: runPath,
								}),
							)
						: Effect.succeed(current),
				),
			);

		const persistStep = (entry: StepEntry) => writeStep(entry.path, entry.record);

		const requireStep = (ord: number, op: string): Effect.Effect<StepEntry, RunRecordingError> =>
			Ref.get(stepEntriesRef).pipe(
				Effect.flatMap((entries) => {
					const entry = entries.get(ord);
					return entry === undefined
						? Effect.fail(
								new RunRecordingError({
									message: `cannot ${op}: step ${ord} not started`,
								}),
							)
						: Effect.succeed(entry);
				}),
			);

		const replaceStep = (entry: StepEntry): Effect.Effect<void> =>
			Ref.update(stepEntriesRef, (entries) => new Map(entries).set(entry.record.ord, entry));

		const appendLog = (kind: 'stdout' | 'stderr', stepOrd: number, n: number, text: string) =>
			Ref.get(iterPathsRef).pipe(
				Effect.flatMap((map) => {
					const paths = map.get(iterKey(stepOrd, n));
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
				}),
			);

		// ---- agent-layout helpers (mirror the step helpers, keyed by AgentSeq) ----
		const persistAgent = (entry: AgentEntry) => writeAgent(entry.path, entry.record);

		const requireAgent = (
			seq: AgentSeq,
			op: string,
		): Effect.Effect<AgentEntry, RunRecordingError> =>
			Ref.get(agentEntriesRef).pipe(
				Effect.flatMap((entries) => {
					const entry = entries.get(seq);
					return entry === undefined
						? Effect.fail(
								new RunRecordingError({ message: `cannot ${op}: agent ${seq} not started` }),
							)
						: Effect.succeed(entry);
				}),
			);

		const replaceAgent = (entry: AgentEntry): Effect.Effect<void> =>
			Ref.update(agentEntriesRef, (entries) => new Map(entries).set(entry.record.seq, entry));

		const appendAgentLog = (kind: 'stdout' | 'stderr', seq: AgentSeq, n: number, text: string) =>
			Ref.get(iterPathsRef).pipe(
				Effect.flatMap((map) => {
					const paths = map.get(agentIterKey(seq, n));
					if (!paths) {
						return Effect.fail(
							new RunRecordingError({
								message: `cannot append ${kind}: agent iter ${seq}/${n} not started`,
							}),
						);
					}
					const file = kind === 'stdout' ? paths.stdoutPath : paths.stderrPath;
					return fs
						.writeFileString(file, text, { flag: 'a' })
						.pipe(Effect.mapError(toRecordingError(`failed to append ${kind}`, file)));
				}),
			);

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
					yield* Ref.set(runRecordRef, record);
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
					yield* Ref.set(runRecordRef, next);
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
					yield* Ref.set(runRecordRef, updated);
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
					yield* replaceStep(entry);
					yield* persistStep(entry);
				}),

			recordStepEnd: (args) =>
				Effect.gen(function* () {
					const entry = yield* requireStep(args.ord, 'end step');
					const endedAt = yield* Clock.currentTimeMillis;
					const next: StepEntry = {
						...entry,
						record: { ...entry.record, endedAt, status: args.status },
					};
					yield* replaceStep(next);
					yield* persistStep(next);
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
						outputPath: path.join(iterDir, 'output.json'),
					};
					yield* Ref.update(iterPathsRef, (m) =>
						new Map(m).set(iterKey(args.stepOrd, args.n), paths),
					);
					yield* writeFile(paths.promptPath, args.prompt);
					const startedAt = yield* Clock.currentTimeMillis;
					const iter: IterRecord = { n: args.n, startedAt };
					const next: StepEntry = {
						...entry,
						record: { ...entry.record, iters: [...entry.record.iters, iter] },
					};
					yield* replaceStep(next);
					yield* persistStep(next);
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
					const next: StepEntry = { ...entry, record: { ...entry.record, iters } };
					yield* replaceStep(next);
					yield* persistStep(next);

					const iterPathsMap = yield* Ref.get(iterPathsRef);
					const iterPaths = iterPathsMap.get(iterKey(args.stepOrd, args.n));
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
						const next: StepEntry = { ...entry, record: { ...entry.record, roles } };
						yield* replaceStep(next);
						yield* persistStep(next);
						return { roleDir, findingsPath } satisfies RolePaths;
					}),
				),

			recordRoleEnd: (args) =>
				roleMutex.withPermits(1)(
					Effect.gen(function* () {
						const entry = yield* requireStep(
							args.stepOrd,
							`end role ${args.stepOrd}/${args.roleId}`,
						);
						const existing = entry.record.roles ?? [];
						const nextRoles = existing.slice();
						let idx = -1;
						for (let i = 0; i < nextRoles.length; i++) {
							if (nextRoles[i]?.name === args.roleId) {
								idx = i;
								break;
							}
						}
						const current = idx < 0 ? undefined : nextRoles[idx];
						if (current === undefined) {
							return yield* Effect.fail(
								new RunRecordingError({
									message: `cannot end role ${args.stepOrd}/${args.roleId}: role not started`,
								}),
							);
						}
						const endedAt = yield* Clock.currentTimeMillis;
						nextRoles[idx] = {
							name: current.name,
							harness: current.harness,
							startedAt: current.startedAt,
							endedAt,
							status: args.status,
							findings: args.findings,
							...(args.errorTag === undefined ? {} : { errorTag: args.errorTag }),
						};
						const next: StepEntry = {
							...entry,
							record: { ...entry.record, roles: nextRoles },
						};
						yield* replaceStep(next);
						yield* persistStep(next);
					}),
				),

			appendEvent: (event) => appendLine(eventsPath, JSON.stringify(event)),

			appendStdout: (stepOrd, n, text) => appendLog('stdout', stepOrd, n, text),

			appendStderr: (stepOrd, n, text) => appendLog('stderr', stepOrd, n, text),

			appendIterEvent: (stepOrd, n, event) =>
				Ref.get(iterPathsRef).pipe(
					Effect.flatMap((map) => {
						const paths = map.get(iterKey(stepOrd, n));
						if (!paths) {
							return Effect.fail(
								new RunRecordingError({
									message: `cannot append iter event: iter ${stepOrd}/${n} not started`,
								}),
							);
						}
						return appendLine(paths.eventsPath, JSON.stringify(event));
					}),
				),

			recordAgentStart: (args) =>
				roleMutex.withPermits(1)(
					Effect.gen(function* () {
						const dir = path.join(runDir, agentDirName(args.seq, args.label));
						yield* ensureDir(dir);
						const startedAt = yield* Clock.currentTimeMillis;
						const record: AgentRecord = {
							seq: args.seq,
							label: args.label,
							promptHash: args.promptHash,
							optsHash: args.optsHash,
							harness: args.harness,
							startedAt,
							status: 'running',
							iters: [],
						};
						const entry: AgentEntry = { dir, path: path.join(dir, 'agent.json'), record };
						yield* replaceAgent(entry);
						yield* persistAgent(entry);
					}),
				),

			recordAgentIterStart: (args) =>
				Effect.gen(function* () {
					const entry = yield* requireAgent(args.seq, `start iter ${args.seq}/${args.n}`);
					const iterDir = path.join(entry.dir, 'iters', pad(args.n, 3));
					yield* ensureDir(iterDir);
					const paths: IterPaths = {
						iterDir,
						stdoutPath: path.join(iterDir, 'stdout.log'),
						stderrPath: path.join(iterDir, 'stderr.log'),
						promptPath: path.join(iterDir, 'prompt.md'),
						eventsPath: path.join(iterDir, 'events.jsonl'),
						outputPath: path.join(iterDir, 'output.json'),
					};
					yield* Ref.update(iterPathsRef, (m) =>
						new Map(m).set(agentIterKey(args.seq, args.n), paths),
					);
					yield* writeFile(paths.promptPath, args.prompt);
					const startedAt = yield* Clock.currentTimeMillis;
					const iter: IterRecord = { n: args.n, startedAt };
					const next: AgentEntry = {
						...entry,
						record: { ...entry.record, iters: [...entry.record.iters, iter] },
					};
					yield* replaceAgent(next);
					yield* persistAgent(next);
					return paths;
				}),

			recordAgentIterEnd: (args) =>
				Effect.gen(function* () {
					const entry = yield* requireAgent(args.seq, `end iter ${args.seq}/${args.n}`);
					const idx = entry.record.iters.findIndex((it) => it.n === args.n);
					const existing = idx < 0 ? undefined : entry.record.iters[idx];
					if (existing === undefined) {
						return yield* Effect.fail(
							new RunRecordingError({
								message: `cannot end iter ${args.seq}/${args.n}: iter not started`,
							}),
						);
					}
					const endedAt = yield* Clock.currentTimeMillis;
					const updatedIter: IterRecord = {
						...existing,
						n: args.n,
						endedAt,
						exitCode: args.exitCode,
					};
					const iters = entry.record.iters.map((it, i) => (i === idx ? updatedIter : it));
					const next: AgentEntry = { ...entry, record: { ...entry.record, iters } };
					yield* replaceAgent(next);
					yield* persistAgent(next);
				}),

			recordAgentEnd: (args) =>
				Effect.gen(function* () {
					const entry = yield* requireAgent(args.seq, 'end agent');
					const endedAt = yield* Clock.currentTimeMillis;
					const next: AgentEntry = {
						...entry,
						record: {
							...entry.record,
							endedAt,
							status: args.status,
							...(args.output === undefined ? {} : { output: args.output }),
						},
					};
					yield* replaceAgent(next);
					yield* persistAgent(next);
				}),

			appendAgentStdout: (seq, n, text) => appendAgentLog('stdout', seq, n, text),

			appendAgentStderr: (seq, n, text) => appendAgentLog('stderr', seq, n, text),

			appendAgentIterEvent: (seq, n, event) =>
				Ref.get(iterPathsRef).pipe(
					Effect.flatMap((map) => {
						const paths = map.get(agentIterKey(seq, n));
						if (!paths) {
							return Effect.fail(
								new RunRecordingError({
									message: `cannot append agent iter event: agent iter ${seq}/${n} not started`,
								}),
							);
						}
						return appendLine(paths.eventsPath, JSON.stringify(event));
					}),
				),

			findResumableAgent: (seq, promptHash, optsHash) =>
				Ref.get(agentEntriesRef).pipe(
					Effect.map((entries) => {
						const entry = entries.get(seq);
						if (
							entry === undefined ||
							entry.record.status !== 'ok' ||
							entry.record.promptHash !== promptHash ||
							entry.record.optsHash !== optsHash
						) {
							return;
						}
						return { record: entry.record } satisfies ResumableAgent;
					}),
				),
		};
	});

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
		return yield* makeService({ runId, runDir, fs, path });
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

const hydrateAgentEntries = (runDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const agentsRoot = path.join(runDir, 'agents');
		const exists = yield* fs
			.exists(agentsRoot)
			.pipe(Effect.mapError(toRecordingError(`failed to stat ${agentsRoot}`, agentsRoot)));
		const empty: ReadonlyArray<AgentEntry> = [];
		if (!exists) return empty;
		const subdirs = yield* fs
			.readDirectory(agentsRoot)
			.pipe(Effect.mapError(toRecordingError(`failed to read ${agentsRoot}`, agentsRoot)));
		const entries: AgentEntry[] = [];
		for (const name of subdirs) {
			const dir = path.join(agentsRoot, name);
			const agentJsonPath = path.join(dir, 'agent.json');
			const has = yield* fs
				.exists(agentJsonPath)
				.pipe(Effect.mapError(toRecordingError(`failed to stat ${agentJsonPath}`, agentJsonPath)));
			if (!has) continue;
			const record = yield* readAgent(agentJsonPath);
			entries.push({ dir, path: agentJsonPath, record });
		}
		const sorted: ReadonlyArray<AgentEntry> = entries.toSorted(
			(a, b) => a.record.seq - b.record.seq,
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
		const agentEntries = yield* hydrateAgentEntries(runDir);
		return yield* makeService({
			runId,
			runDir,
			fs,
			path,
			hydrated: { runRecord, stepEntries, agentEntries },
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
