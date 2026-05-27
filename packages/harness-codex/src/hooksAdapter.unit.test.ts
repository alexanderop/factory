import { assertAdapterContract } from '@factory/hooks/testing';
import { describe, it } from 'vitest';
import { codexHooksAdapter } from './hooksAdapter.ts';

describe('codexHooksAdapter', () => {
	it('satisfies the adapter contract for 6 of 7 events (postToolUseFailure synthesized client-side)', () => {
		assertAdapterContract(codexHooksAdapter, {
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
