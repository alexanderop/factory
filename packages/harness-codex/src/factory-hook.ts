#!/usr/bin/env node
import { request } from 'node:http';

/** Codex hook shim. Codex only supports `command` hooks, so its hook config
 *  invokes `factory-hook <socketPath> <route>`. This bridges that to the same
 *  `POST /hook/<route>` unix-socket endpoint the HTTP-native harnesses call:
 *  reads the native payload from stdin, posts it, writes the decision response
 *  to stdout. Any transport failure emits `{}` (allow) so a hook hiccup never
 *  wedges the agent. */

const [socketPath, route] = process.argv.slice(2);

const readStdin = (): Promise<string> =>
	new Promise((resolve) => {
		let data = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', (chunk: string) => {
			data += chunk;
		});
		process.stdin.on('end', () => resolve(data));
		// Mirror the HTTP side's fail-open error handling: a broken stdin pipe must
		// resolve (with whatever we have) rather than hang or throw on an unhandled
		// 'error' event, so a transport hiccup never wedges the agent.
		process.stdin.on('error', () => resolve(data));
	});

const postHook = (socket: string, path: string, body: string): Promise<string> =>
	new Promise((resolve) => {
		const req = request(
			{ socketPath: socket, path, method: 'POST', headers: { 'content-type': 'application/json' } },
			(res) => {
				let out = '';
				res.setEncoding('utf8');
				res.on('data', (chunk: string) => {
					out += chunk;
				});
				res.on('end', () => resolve(out));
			},
		);
		req.on('error', () => resolve('{}'));
		req.write(body);
		req.end();
	});

if (socketPath === undefined || route === undefined) {
	process.stderr.write('factory-hook: usage: factory-hook <socketPath> <route>\n');
	process.exitCode = 2;
} else {
	const response = await postHook(socketPath, `/hook/${route}`, await readStdin());
	process.stdout.write(response);
}
