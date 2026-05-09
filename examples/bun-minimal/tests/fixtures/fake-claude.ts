import { argv, env, exit, stdout } from 'node:process';

const lines = [
	'{"type":"system","subtype":"init"}',
	'not-json-noise-line',
	'{"type":"assistant","message":{"content":[{"type":"text","text":"hello from fake claude\\n"}]}}',
	'{"type":"assistant","message":{"content":[{"type":"text","text":"' +
		(env.FAKE_EMIT_COMPLETE === '1' ? '<promise>COMPLETE</promise>' : 'still working') +
		'"}]}}',
	'{"type":"result","is_error":false,"duration_ms":1,"usage":{"input_tokens":1,"output_tokens":1}}',
];

for (const line of lines) {
	stdout.write(`${line}\n`);
}

if (argv.includes('--fail')) exit(2);
