import { describe, expect, it } from 'vitest';
import { toolInputAttributes, toolOutputAttributes } from './observability.ts';

describe('toolInputAttributes', () => {
	const longCommand = 'a'.repeat(300);

	const inputCases = [
		[
			'Bash with short command sets cmd.head + cmd.bytes',
			'Bash',
			{ command: 'ls -la' },
			{ 'tool.cmd.head': 'ls -la', 'tool.cmd.bytes': 6 },
		],
		[
			'Bash with long command truncates head to 200 chars but reports full byte length',
			'Bash',
			{ command: longCommand },
			{ 'tool.cmd.head': longCommand.slice(0, 200), 'tool.cmd.bytes': 300 },
		],
		['Read sets file_path', 'Read', { file_path: '/x' }, { 'tool.file_path': '/x' }],
		['Write sets file_path', 'Write', { file_path: '/x' }, { 'tool.file_path': '/x' }],
		['Edit sets file_path', 'Edit', { file_path: '/x' }, { 'tool.file_path': '/x' }],
		[
			'NotebookEdit sets file_path',
			'NotebookEdit',
			{ file_path: '/x' },
			{ 'tool.file_path': '/x' },
		],
		['Glob sets pattern', 'Glob', { pattern: '**/*.ts' }, { 'tool.pattern': '**/*.ts' }],
		['Grep sets pattern', 'Grep', { pattern: 'foo' }, { 'tool.pattern': 'foo' }],
		['Unknown tool returns empty attrs', 'Unknown', { foo: 'bar' }, {}],
		['non-record input returns empty attrs', 'Bash', 'not a record', {}],
		[
			'Bash with non-string command falls back to empty cmd',
			'Bash',
			{ command: 123 },
			{ 'tool.cmd.head': '', 'tool.cmd.bytes': 0 },
		],
	] as const;

	it.each(inputCases)('%s', (_label, tool, input, expected) => {
		expect(toolInputAttributes(tool, input)).toEqual(expected);
	});
});

describe('toolOutputAttributes', () => {
	const outputCases = [
		[
			'Bash with stdout/stderr/exit_code populates all three',
			'Bash',
			{ stdout: 'out', stderr: '', exit_code: 0 },
			{ 'tool.exit_code': 0, 'tool.stdout.bytes': 3, 'tool.stderr.bytes': 0 },
		],
		[
			'Bash supports camelCase exitCode',
			'Bash',
			{ stdout: 'a', exitCode: 1 },
			{ 'tool.exit_code': 1, 'tool.stdout.bytes': 1 },
		],
		[
			'Bash snake_case timed_out is surfaced',
			'Bash',
			{ timed_out: true },
			{ 'tool.timed_out': true },
		],
		['Bash camelCase timedOut is surfaced', 'Bash', { timedOut: true }, { 'tool.timed_out': true }],
		[
			'Bash plain string is treated as stdout',
			'Bash',
			'plain string',
			{ 'tool.stdout.bytes': Buffer.byteLength('plain string', 'utf8') },
		],
		[
			'Read with newline-separated string counts lines and bytes',
			'Read',
			'one\ntwo\nthree',
			{ 'tool.file.lines': 3, 'tool.file.bytes': 13 },
		],
		[
			'Read with array of text blocks joins and reports single line',
			'Read',
			[{ text: 'a' }, { text: 'b' }],
			{ 'tool.file.lines': 1, 'tool.file.bytes': 2 },
		],
		[
			'Read with { text } record extracts text',
			'Read',
			{ text: 'hello' },
			{ 'tool.file.lines': 1, 'tool.file.bytes': 5 },
		],
		['Read with undefined output returns empty attrs', 'Read', undefined, {}],
		[
			'Write with bytes_before/after + lines_added/removed sets all four',
			'Write',
			{ bytes_before: 10, bytes_after: 20, lines_added: 2, lines_removed: 1 },
			{
				'tool.file.bytes_before': 10,
				'tool.file.bytes_after': 20,
				'tool.lines_added': 2,
				'tool.lines_removed': 1,
			},
		],
		['Write omits missing fields', 'Write', { bytes_before: 10 }, { 'tool.file.bytes_before': 10 }],
		['Write with non-record output returns empty attrs', 'Write', 'not a record', {}],
		[
			'Grep counts newline-separated matches',
			'Grep',
			'match1\nmatch2\nmatch3',
			{ 'tool.matches.count': 3 },
		],
		['Grep with empty string reports zero matches', 'Grep', '', { 'tool.matches.count': 0 }],
		[
			'Grep with whitespace-only trims to zero matches',
			'Grep',
			'  \n',
			{ 'tool.matches.count': 0 },
		],
		[
			'Grep with { matches: number } uses the direct count',
			'Grep',
			{ matches: 5 },
			{ 'tool.matches.count': 5 },
		],
		['Grep with undefined output returns empty attrs', 'Grep', undefined, {}],
		[
			'Glob mirrors Grep semantics on newline-separated string',
			'Glob',
			'a\nb',
			{ 'tool.matches.count': 2 },
		],
		[
			'Glob mirrors Grep on direct matches count',
			'Glob',
			{ matches: 7 },
			{ 'tool.matches.count': 7 },
		],
		['Unknown tool returns empty attrs even when ok=true', 'Unknown', { any: 'thing' }, {}],
	] as const;

	it.each(outputCases)('%s', (_label, tool, output, expected) => {
		expect(toolOutputAttributes(tool, output, true)).toEqual(expected);
	});
});
