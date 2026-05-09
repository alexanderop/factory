#!/usr/bin/env -S node --experimental-strip-types
import { NodeContext, NodeRuntime } from '@effect/platform-node';
import { withFriendlyErrors } from '@factory/core';
import { Effect } from 'effect';
import { cli } from './cli.ts';

NodeRuntime.runMain(cli(process.argv).pipe(withFriendlyErrors, Effect.provide(NodeContext.layer)), {
	disableErrorReporting: true,
});
