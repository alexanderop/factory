#!/usr/bin/env -S node --experimental-strip-types
import { run } from './run.ts';

const [, , command, ...rest] = process.argv;

if (!command || command === 'help' || command === '--help' || command === '-h') {
	printHelp();
	process.exit(0);
}

if (command === 'run') {
	const exitCode = await run(rest);
	process.exit(exitCode);
}

console.error(`unknown command: ${command}`);
printHelp();
process.exit(1);

function printHelp(): void {
	console.log(`factory — software factory pipelines

usage:
  factory run <name> --prd <file|text> [--cwd <dir>] [--no-otel]

flags:
  --prd <value>   markdown file path or inline text
  --cwd <dir>     working directory (default: cwd)
  --no-otel       disable OpenTelemetry
  -h, --help      print this help
`);
}
