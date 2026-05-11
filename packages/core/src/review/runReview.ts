import { FileSystem, Path, type CommandExecutor } from '@effect/platform';
import { Effect } from 'effect';
import {
	type FactoryError,
	MissingHarnessError,
	RoleLoadError,
	RunRecordingError,
} from '../errors.ts';
import { HarnessName, MIXED_HARNESS, type RunId, StepId } from '../ids.ts';
import { emitAndRecord, factoryHarnessEnv, resolvePermissions } from '../pipelineHelpers.ts';
import { Display } from '../services/Display.ts';
import { EventEmitter } from '../services/EventEmitter.ts';
import { HarnessRegistry } from '../services/HarnessRegistry.ts';
import { atomicWriteString } from '../services/runManifest.ts';
import { RunWorkspace } from '../services/RunWorkspace.ts';
import { StepLoader } from '../services/StepLoader.ts';
import type { ExecOpts, FactoryOptions, PermissionMode, ReviewEntry, RoleEntry } from '../types.ts';
import {
	decodeRoleFindings,
	encodeFindings,
	type Finding,
	type Findings,
	type RoleFinding,
	type Severity,
} from './finding.ts';

interface RoleFailure {
	readonly role: string;
	readonly message: string;
	readonly cause: string;
}

const stampFinding = (roleId: string, raw: RoleFinding): Finding => ({
	role: roleId,
	severity: raw.severity,
	file: raw.file,
	message: raw.message,
	...(raw.line === undefined ? {} : { line: raw.line }),
	...(raw.suggestion === undefined ? {} : { suggestion: raw.suggestion }),
});

interface ReviewContext {
	readonly runId: RunId;
	readonly stepOrd: number;
	readonly cwd: string;
	readonly prd: string;
	readonly defaultHarness: HarnessName | undefined;
	readonly factoryOpts: FactoryOptions;
	readonly permissionsOverride: PermissionMode | undefined;
}

interface RunRoleArgs extends ReviewContext {
	readonly stepId: StepId;
	readonly role: RoleEntry;
}

const resolveRoleHarnessName = (
	role: RoleEntry,
	defaultHarness: HarnessName | undefined,
): HarnessName | undefined =>
	role.options.harness ? HarnessName.make(role.options.harness) : defaultHarness;

const runRole = (
	args: RunRoleArgs,
): Effect.Effect<
	ReadonlyArray<Finding>,
	RoleFailure,
	| StepLoader
	| HarnessRegistry
	| RunWorkspace
	| CommandExecutor.CommandExecutor
	| FileSystem.FileSystem
	| Path.Path
> =>
	Effect.gen(function* () {
		const workspace = yield* RunWorkspace;
		const registry = yield* HarnessRegistry;
		const loader = yield* StepLoader;
		const fs = yield* FileSystem.FileSystem;

		const loaded = yield* loader.load(args.role.source, args.cwd).pipe(
			Effect.mapError(
				(e) =>
					new RoleLoadError({
						message: e.message,
						path: e.path,
						role: args.role.id,
					}),
			),
		);

		const harnessName = resolveRoleHarnessName(args.role, args.defaultHarness);
		if (!harnessName) {
			return yield* Effect.fail(
				new MissingHarnessError({
					message: `role '${args.role.id}' has no harness (factory({harness}), role option, or frontmatter required)`,
					step: args.stepId,
				}),
			);
		}
		const harness = yield* registry.resolve(harnessName);

		// From this point on, role start is recorded on disk; failures get
		// persisted via the outer `catchAll` below.
		const { roleDir, findingsPath } = yield* workspace.recordRoleStart({
			stepOrd: args.stepOrd,
			roleId: args.role.id,
			harness: harnessName,
		});

		const permissions = resolvePermissions(
			args.permissionsOverride,
			loaded,
			args.role.options,
			args.factoryOpts,
			harness,
		);

		const prompt = `# PRD\n\n${args.prd}\n\n# Role: ${args.role.id}\n\n${loaded.prompt}`;
		const execOpts: ExecOpts = {
			prompt,
			cwd: args.cwd,
			env: {
				...factoryHarnessEnv(workspace.runDir, args.cwd, args.runId),
				FACTORY_ROLE_ID: args.role.id,
				FACTORY_ROLE_DIR: roleDir,
			},
			permissions,
		};

		yield* harness.exec(execOpts);

		const raw = yield* fs.readFileString(findingsPath);
		const decoded = yield* decodeRoleFindings(raw);

		const stamped = decoded.findings.map((f) => stampFinding(args.role.id, f));

		yield* workspace.recordRoleEnd({
			stepOrd: args.stepOrd,
			roleId: args.role.id,
			status: 'ok',
			findings: stamped.length,
		});

		return stamped;
	}).pipe(
		Effect.catchAll((cause) =>
			Effect.gen(function* () {
				const workspace = yield* RunWorkspace;
				yield* workspace
					.recordRoleEnd({
						stepOrd: args.stepOrd,
						roleId: args.role.id,
						status: 'failed',
						findings: 1,
						errorTag: cause._tag,
					})
					.pipe(
						Effect.catchAll((e) =>
							Effect.logWarning(
								`could not persist failure for role '${args.role.id}': ${e.message}`,
							),
						),
					);
				return yield* Effect.fail({
					role: args.role.id,
					message: cause.message,
					cause: cause._tag,
				} satisfies RoleFailure);
			}),
		),
	);

interface RunReviewArgs extends ReviewContext {
	readonly entry: ReviewEntry;
}

const SYNTHETIC_FAILURE_SEVERITY: Severity = 'P3';

const mergeFindings = (
	successes: ReadonlyArray<ReadonlyArray<Finding>>,
	failures: ReadonlyArray<RoleFailure>,
): Findings => {
	const findings: Finding[] = [];
	for (const arr of successes) {
		for (const f of arr) findings.push(f);
	}
	for (const f of failures) {
		findings.push({
			role: f.role,
			severity: SYNTHETIC_FAILURE_SEVERITY,
			file: '<review>',
			message: `review role '${f.role}' failed: ${f.message}`,
		});
	}
	return { findings };
};

const renderReviewManifest = (entry: ReviewEntry): string => {
	const lines = [
		`---`,
		`kind: review`,
		`name: ${entry.id}`,
		`---`,
		``,
		`# Review step: ${entry.id}`,
		``,
		`Roles:`,
		...entry.roles.map((r) => `- ${r.id} (${r.source})`),
	];
	if (entry.aggregate) {
		lines.push(``, `Aggregator: ${entry.aggregate.id} (${entry.aggregate.source})`);
	}
	return lines.join('\n');
};

export const runReview = (
	args: RunReviewArgs,
): Effect.Effect<
	void,
	FactoryError,
	| Display
	| EventEmitter
	| HarnessRegistry
	| StepLoader
	| RunWorkspace
	| CommandExecutor.CommandExecutor
	| FileSystem.FileSystem
	| Path.Path
> =>
	Effect.gen(function* () {
		const display = yield* Display;
		const emitter = yield* EventEmitter;
		const workspace = yield* RunWorkspace;
		const path = yield* Path.Path;

		const stepId = StepId.make(args.entry.id);
		const harnessForRecord =
			(args.entry.options.harness ? HarnessName.make(args.entry.options.harness) : undefined) ??
			args.defaultHarness ??
			MIXED_HARNESS;

		yield* workspace.recordStepStart({
			ord: args.stepOrd,
			stepId,
			source: '<review>',
			harness: harnessForRecord,
			until: undefined,
			maxIters: 1,
			stepFileContent: renderReviewManifest(args.entry),
		});
		yield* emitAndRecord(emitter, workspace, {
			type: 'step.start',
			runId: args.runId,
			step: stepId,
		});
		yield* display.stepStart(stepId);

		const [failures, successes] = yield* Effect.partition(
			args.entry.roles,
			(role) => runRole({ ...args, stepId, role }),
			{ concurrency: args.entry.concurrency ?? 'unbounded' },
		);

		const merged = mergeFindings(successes, failures);
		const mergedPath = path.join(workspace.runDir, 'findings.json');
		const mergedJson = yield* encodeFindings(merged).pipe(
			Effect.mapError(
				(e) =>
					new RunRecordingError({
						message: `failed to encode findings.json: ${e.message}`,
						path: mergedPath,
					}),
			),
		);
		yield* atomicWriteString(mergedPath, mergedJson);

		yield* workspace.recordStepEnd({ ord: args.stepOrd, status: 'ok' });
		yield* emitAndRecord(emitter, workspace, {
			type: 'step.end',
			runId: args.runId,
			step: stepId,
			ok: true,
		});
		yield* display.stepEnd(stepId, true);
	}).pipe(
		Effect.withSpan(`factory.review ${args.entry.id}`, {
			attributes: {
				'factory.review.id': args.entry.id,
				'factory.review.roles.count': args.entry.roles.length,
				'factory.run.id': args.runId,
			},
		}),
	);
