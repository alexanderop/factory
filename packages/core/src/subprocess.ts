import { spawn } from 'node:child_process';
import type { ExecOpts, ExecResult, Harness, HarnessEvent } from './types.ts';

export interface SubprocessHarnessConfig {
	name: string;
	bin: string;
	buildArgs(prompt: string): string[];
}

export function createSubprocessHarness(config: SubprocessHarnessConfig): Harness {
	const { name, bin, buildArgs } = config;

	return {
		name,
		async exec(opts: ExecOpts): Promise<ExecResult> {
			let stdout = '';
			let stderr = '';
			let exitCode = 0;
			for await (const event of streamSubprocess(bin, buildArgs(opts.prompt), opts)) {
				if (event.type === 'stdout') stdout += `${event.line}\n`;
				else if (event.type === 'stderr') stderr += `${event.line}\n`;
				else if (event.type === 'exit') exitCode = event.code;
			}
			return { exitCode, stdout, stderr };
		},
		stream(opts: ExecOpts) {
			return streamSubprocess(bin, buildArgs(opts.prompt), opts);
		},
	};
}

async function* streamSubprocess(
	bin: string,
	args: string[],
	opts: ExecOpts,
): AsyncIterable<HarnessEvent> {
	const child = spawn(bin, args, {
		cwd: opts.cwd ?? process.cwd(),
		env: { ...process.env, ...opts.env },
		signal: opts.signal,
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	const queue: HarnessEvent[] = [];
	let done = false;
	let resolve: (() => void) | undefined;
	const wake = () => {
		resolve?.();
		resolve = undefined;
	};

	const onLine = (type: 'stdout' | 'stderr') => (chunk: Buffer) => {
		const text = chunk.toString('utf8');
		for (const line of text.split('\n')) {
			if (line.length === 0) continue;
			queue.push({ type, line });
		}
		wake();
	};

	child.stdout.on('data', onLine('stdout'));
	child.stderr.on('data', onLine('stderr'));
	child.on('exit', (code) => {
		queue.push({ type: 'exit', code: code ?? 0 });
		done = true;
		wake();
	});

	let timer: NodeJS.Timeout | undefined;
	if (opts.timeoutMs) {
		timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs);
	}

	try {
		while (!done || queue.length > 0) {
			if (queue.length === 0) {
				await new Promise<void>((r) => {
					resolve = r;
				});
				continue;
			}
			const event = queue.shift();
			if (event) yield event;
		}
	} finally {
		if (timer) clearTimeout(timer);
	}
}
