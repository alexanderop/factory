import type { Harness } from './types.ts';

const registry = new Map<string, Harness>();

export function registerHarness(harness: Harness): void {
	registry.set(harness.name, harness);
}

export function resolveHarness(name: string): Harness {
	const harness = registry.get(name);
	if (!harness) {
		throw new Error(
			`unknown harness '${name}' — register one via registerHarness() or install @factory/harness-${name}`,
		);
	}
	return harness;
}
