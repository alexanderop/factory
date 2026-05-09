import { Context, Effect, Layer, Ref } from 'effect';
import type { FactoryEvent } from '../types.ts';

export interface EventEmitterService {
	readonly emit: (event: FactoryEvent) => Effect.Effect<void>;
}

export class EventEmitter extends Context.Tag('@factory/EventEmitter')<
	EventEmitter,
	EventEmitterService
>() {}

export interface EventCallbacks {
	readonly onStep?: (event: FactoryEvent) => void;
	readonly onError?: (event: Extract<FactoryEvent, { type: 'error' }>) => void;
}

export const callbackEventEmitter = {
	layer: (callbacks: EventCallbacks): Layer.Layer<EventEmitter> =>
		Layer.succeed(EventEmitter, {
			emit: (event) =>
				Effect.sync(() => {
					callbacks.onStep?.(event);
					if (event.type === 'error') callbacks.onError?.(event);
				}),
		}),
};

export const noopEventEmitter = {
	layer: Layer.succeed(EventEmitter, { emit: () => Effect.void } satisfies EventEmitterService),
};

export const recordingEventEmitter = {
	layer: (ref: Ref.Ref<ReadonlyArray<FactoryEvent>>): Layer.Layer<EventEmitter> =>
		Layer.succeed(EventEmitter, {
			emit: (event) => Ref.update(ref, (e) => [...e, event]),
		}),
};
