import { spawn } from 'bun';
import { resolve } from 'node:path';
import { argv, env, stdout } from 'node:process';

export interface Step {
	readonly name: string;
	readonly maxIters: number;
	readonly done: (assistantText: string) => boolean;
}

export const STEPS: readonly Step[] = [
	{ name: 'plan', maxIters: 1, done: () => true },
	{
		name: 'ralph',
		maxIters: 10,
		done: (out) => out.includes('<promise>COMPLETE</promise>'),
	},
	{ name: 'review', maxIters: 2, done: () => true },
];

export const buildPrompt = (prd: string, stepBody: string): string =>
	`# PRD\n\n${prd}\n\n# Step\n\n${stepBody}`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export const parseAssistantText = (line: string): string => {
	const trimmed = line.trim();
	if (trimmed === '') return '';
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return '';
	}
	if (!isRecord(parsed) || parsed.type !== 'assistant') return '';
	const message = parsed.message;
	if (!isRecord(message) || !Array.isArray(message.content)) return '';
	let text = '';
	for (const block of message.content) {
		if (!isRecord(block)) continue;
		if (block.type !== 'text') continue;
		if (typeof block.text === 'string') text += block.text;
	}
	return text;
};

export interface RunStepOptions {
	readonly cwd: string;
	readonly prd: string;
	readonly stepBody: string;
	readonly planPath: string;
	readonly bin?: string;
	readonly extraArgs?: readonly string[];
	readonly write?: (chunk: string) => void;
}

export const runStep = async (step: Step, opts: RunStepOptions): Promise<void> => {
	const write =
		opts.write ??
		((chunk: string) => {
			stdout.write(chunk);
		});
	const bin = opts.bin ?? 'claude';
	const prompt = buildPrompt(opts.prd, opts.stepBody);
	const baseArgs = opts.extraArgs ?? [
		'--dangerously-skip-permissions',
		'--output-format',
		'stream-json',
		'--verbose',
	];

	for (let iter = 1; iter <= step.maxIters; iter++) {
		write(`\n--- ${step.name} iter ${iter}/${step.maxIters} ---\n`);
		// oxlint-disable-next-line no-await-in-loop -- iters are sequential by design
		const proc = spawn([bin, ...baseArgs, '-p', prompt], {
			cwd: opts.cwd,
			env: { ...env, FACTORY_PROJECT_PLAN: opts.planPath },
			stdout: 'pipe',
			stderr: 'inherit',
		});

		const decoder = new TextDecoder();
		let buffer = '';
		let assistantText = '';
		// oxlint-disable-next-line no-await-in-loop -- stream chunks are inherently sequential
		for await (const chunk of proc.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			let nl = buffer.indexOf('\n');
			while (nl !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				const text = parseAssistantText(line);
				if (text.length > 0) {
					write(text);
					if (!text.endsWith('\n')) write('\n');
					assistantText += text;
				}
				nl = buffer.indexOf('\n');
			}
		}

		// oxlint-disable-next-line no-await-in-loop -- iters are sequential by design
		const code = await proc.exited;
		if (code !== 0) {
			throw new Error(`claude exited with code ${code} during step '${step.name}' iter ${iter}`);
		}
		if (step.done(assistantText)) return;
	}

	write(`\n[${step.name}] reached maxIters=${step.maxIters}\n`);
};

export const main = async (here: string): Promise<void> => {
	const dryRun = argv.includes('--dry-run');
	const prd = await Bun.file(resolve(here, 'prd.md')).text();
	const planPath = resolve(here, 'IMPLEMENTATION_PLAN.md');

	for (const step of STEPS) {
		// oxlint-disable-next-line no-await-in-loop -- steps run sequentially by design
		const stepBody = await Bun.file(resolve(here, 'steps', `${step.name}.md`)).text();
		if (dryRun) {
			stdout.write(`\n=== ${step.name} (dry-run) ===\n`);
			stdout.write(`prompt bytes: ${buildPrompt(prd, stepBody).length}\n`);
			stdout.write(`maxIters: ${step.maxIters}\n`);
			continue;
		}
		stdout.write(`\n=== ${step.name} ===\n`);
		// oxlint-disable-next-line no-await-in-loop -- steps run sequentially by design
		await runStep(step, { cwd: here, prd, stepBody, planPath });
	}
};

if (import.meta.main) {
	await main(import.meta.dir);
}
