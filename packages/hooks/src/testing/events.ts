import { HarnessName, RunId, StepId } from '@factory/core';
import type {
	FactoryHookEvent,
	PostToolUseEvent,
	PreToolUseEvent,
	SessionStartEvent,
	StopEvent,
} from '../events.ts';

const RUN = RunId.make('r1');
const STEP = StepId.make('plan');
const HARNESS = HarnessName.make('claude-code');

export const makeSessionStartEvent = (
	overrides?: Partial<SessionStartEvent>,
): SessionStartEvent => ({
	_tag: 'sessionStart',
	runId: RUN,
	stepId: STEP,
	iter: 1,
	harness: HARNESS,
	source: 'startup',
	...overrides,
});

export const makePreToolUseEvent = (overrides?: Partial<PreToolUseEvent>): PreToolUseEvent => ({
	_tag: 'preToolUse',
	runId: RUN,
	stepId: STEP,
	iter: 1,
	harness: HARNESS,
	tool: 'Bash',
	input: { command: 'ls' },
	toolCallId: 'tc_1',
	...overrides,
});

export const makePostToolUseEvent = (overrides?: Partial<PostToolUseEvent>): PostToolUseEvent => ({
	_tag: 'postToolUse',
	runId: RUN,
	stepId: STEP,
	iter: 1,
	harness: HARNESS,
	tool: 'Bash',
	input: { command: 'ls' },
	output: { stdout: 'file.txt\n' },
	toolCallId: 'tc_1',
	durationMs: 5,
	...overrides,
});

export const makeStopEvent = (overrides?: Partial<StopEvent>): StopEvent => ({
	_tag: 'stop',
	runId: RUN,
	stepId: STEP,
	iter: 1,
	harness: HARNESS,
	lastAssistantMessage: 'done',
	...overrides,
});

export const allEventFactories: ReadonlyArray<() => FactoryHookEvent> = [
	makeSessionStartEvent,
	makePreToolUseEvent,
	makePostToolUseEvent,
	makeStopEvent,
];
