import { assertAdapterContract } from '@factory/hooks/testing';
import { describe, it } from 'vitest';
import { claudeHooksAdapter } from './hooksAdapter.ts';

describe('claudeHooksAdapter', () => {
	it('satisfies the adapter contract for 6 of 7 events (postToolUseFailure synthesized client-side)', () => {
		assertAdapterContract(claudeHooksAdapter, {
			supportedEvents: [
				'sessionStart',
				'userPromptSubmit',
				'preToolUse',
				'postToolUse',
				'stop',
				'permissionRequest',
			],
			format: 'json',
		});
	});
});
