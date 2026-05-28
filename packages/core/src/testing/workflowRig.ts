import { type Effect, Layer, type Ref } from 'effect';
import { RunId } from '../ids.ts';
import * as AgentSequence from '../services/AgentSequence.ts';
import type { DisplayEntry } from '../services/Display.ts';
import type { HookEvent } from '../services/HookRunner.ts';
import type { FactoryEvent, PermissionMode } from '../types.ts';
import { workflowContextLayer } from '../workflow/context.ts';
import { makeTestRig, type MakeTestLayerOptions } from './factories.ts';

export interface MakeWorkflowRigOptions extends MakeTestLayerOptions {
	readonly cwd?: string;
	readonly budget?: number;
	readonly args?: Record<string, unknown>;
	readonly defaultHarness?: string;
	readonly defaultPermissions?: PermissionMode;
	readonly agentSeqStart?: number;
}

export interface WorkflowRig {
	readonly layer: ReturnType<typeof buildWorkflowLayer>;
	readonly events: Effect.Effect<ReadonlyArray<FactoryEvent>>;
	readonly display: Effect.Effect<ReadonlyArray<DisplayEntry>>;
	readonly hookEvents: Effect.Effect<ReadonlyArray<HookEvent>>;
	readonly eventsRef: Ref.Ref<ReadonlyArray<FactoryEvent>>;
	readonly displayRef: Ref.Ref<ReadonlyArray<DisplayEntry>>;
	readonly hookEventsRef: Ref.Ref<ReadonlyArray<HookEvent>>;
}

const buildWorkflowLayer = (
	base: ReturnType<typeof makeTestRig>['layer'],
	options: MakeWorkflowRigOptions,
) => {
	const runId = options.runId ?? RunId.make('test-run');
	const agentSeqLayer =
		options.agentSeqStart === undefined
			? AgentSequence.layer
			: AgentSequence.resumedLayer(options.agentSeqStart);
	const wfLayer = workflowContextLayer({
		runId,
		cwd: options.cwd ?? '/tmp/cwd',
		...(options.defaultHarness === undefined ? {} : { defaultHarness: options.defaultHarness }),
		...(options.defaultPermissions === undefined
			? {}
			: { defaultPermissions: options.defaultPermissions }),
		...(options.args === undefined ? {} : { args: options.args }),
		...(options.budget === undefined ? {} : { budget: options.budget }),
	});
	return Layer.provideMerge(Layer.merge(agentSeqLayer, wfLayer), base);
};

/**
 * `makeTestRig` extended with the `AgentSequence` + `WorkflowContext` layers so
 * programmatic-workflow tests are one line. The WorkflowContext sits on top of
 * the base test layer (which provides Display / EventEmitter / RunWorkspace).
 */
export const makeWorkflowRig = (options: MakeWorkflowRigOptions = {}): WorkflowRig => {
	const base = makeTestRig(options);
	const layer = buildWorkflowLayer(base.layer, options);
	return {
		layer,
		events: base.events,
		display: base.display,
		hookEvents: base.hookEvents,
		eventsRef: base.eventsRef,
		displayRef: base.displayRef,
		hookEventsRef: base.hookEventsRef,
	};
};
