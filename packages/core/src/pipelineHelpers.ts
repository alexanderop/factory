import { Effect } from 'effect';
import { HarnessName, type RunId } from './ids.ts';
import type { EventEmitterService } from './services/EventEmitter.ts';
import type { RunWorkspaceService } from './services/RunWorkspace.ts';
import type { FactoryEvent, FactoryOptions, Harness, LoadedStep, PermissionMode } from './types.ts';

export const resolvePermissions = (
	cliMode: PermissionMode | undefined,
	step: LoadedStep,
	stepOpts: { readonly permissions?: PermissionMode },
	pipeline: FactoryOptions,
	harness: Harness,
): PermissionMode =>
	cliMode ??
	stepOpts.permissions ??
	step.frontmatter.permissions ??
	pipeline.permissions ??
	harness.defaultPermissions ??
	'prompt';

/**
 * Frontmatter-free permission cascade for the programmatic `agent()` path
 * (no `LoadedStep`): opts → ctx default → factory → harness default → 'prompt'.
 */
export const resolveAgentPermissions = (
	optsMode: PermissionMode | undefined,
	ctxMode: PermissionMode | undefined,
	pipeline: FactoryOptions,
	harness: Harness,
): PermissionMode =>
	optsMode ?? ctxMode ?? pipeline.permissions ?? harness.defaultPermissions ?? 'prompt';

/**
 * Resolve the harness name from the available precedence sources, branding the
 * raw option string once. Shared by `runStepLoop` (frontmatter-aware) and the
 * programmatic `agent()` path (frontmatter is `undefined`).
 */
export const resolveHarnessName = (
	optsHarness: string | undefined,
	frontmatterHarness?: HarnessName,
	defaultHarness?: HarnessName,
): HarnessName | undefined =>
	(optsHarness ? HarnessName.make(optsHarness) : undefined) ?? frontmatterHarness ?? defaultHarness;

export const emitAndRecord = (
	emitter: EventEmitterService,
	workspace: RunWorkspaceService,
	event: FactoryEvent,
) => Effect.zipRight(emitter.emit(event), workspace.appendEvent(event));

export const factoryHarnessEnv = (
	runDir: string,
	cwd: string,
	runId: RunId,
): Record<string, string> => ({
	FACTORY_RUN_DIR: runDir,
	FACTORY_RUN_ID: runId,
	FACTORY_RUN_SHORT_ID: runId.slice(0, 8),
	FACTORY_PROJECT_PLAN: `${cwd}/IMPLEMENTATION_PLAN.md`,
});
