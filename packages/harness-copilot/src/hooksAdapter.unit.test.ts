import { assertAdapterContract } from '@factory/hooks/testing';
import { describe, it } from 'vitest';
import { copilotHooksAdapter } from './hooksAdapter.ts';

describe('copilotHooksAdapter', () => {
	it('satisfies the adapter contract for 6 of 7 events (postToolUseFailure synthesized client-side)', () => {
		assertAdapterContract(copilotHooksAdapter, {
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
