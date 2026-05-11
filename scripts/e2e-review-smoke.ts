#!/usr/bin/env -S node --experimental-strip-types
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factory } from '@factory/core';
import { claudeCode } from '@factory/harness-claude-code';

const cwd = await mkdtemp(join(tmpdir(), 'factory-review-smoke-'));
console.log(`smoke: cwd=${cwd}`);

const prdPath = join(cwd, 'prd.md');
await writeFile(
	prdPath,
	`# Review the following code snippet

This is the snippet under review (it lives conceptually at
\`src/user.ts\`):

\`\`\`ts
function getUser(id: string) {
  const query = "SELECT * FROM users WHERE id = '" + id + "'";
  return db.exec(query);
}
\`\`\`

Each role below will produce findings. Output goes to JSON files that the
orchestrator will merge.
`,
);

const rolesDir = join(cwd, 'roles');
await mkdir(rolesDir, { recursive: true });

const roleInstructions = `Write findings to \`$FACTORY_ROLE_DIR/findings.json\` with this exact JSON shape:

\`\`\`json
{
  "findings": [
    {
      "severity": "P1" | "P2" | "P3",
      "file": "<filename>",
      "line": <number, optional>,
      "message": "<one-line summary>",
      "suggestion": "<short fix idea, optional>"
    }
  ]
}
\`\`\`

Severities: P1 = critical/exploitable, P2 = important, P3 = minor.

Use Bash to discover \`$FACTORY_ROLE_DIR\` (\`echo $FACTORY_ROLE_DIR\`), then
write the file there with the Write tool.

When the file is written, end your final message with this exact token on
its own line:

\`\`\`
<promise>REVIEWED</promise>
\`\`\`
`;

await writeFile(
	join(rolesDir, 'security.md'),
	`---
name: security
---

You are a security reviewer. The PRD above contains a code snippet from
\`src/user.ts\`. Identify SECURITY issues only (injection, auth, secrets,
unsafe deserialisation, etc.).

${roleInstructions}`,
);

await writeFile(
	join(rolesDir, 'quality.md'),
	`---
name: quality
---

You are a code-quality reviewer. The PRD above contains a code snippet from
\`src/user.ts\`. Identify QUALITY issues only (naming, types, missing error
handling, missing return type, etc.). Skip security issues — that's a
different role.

${roleInstructions}`,
);

const def = factory({
	name: 'review-smoke',
	harness: 'claude-code',
	harnesses: [claudeCode],
}).review('review', {
	roles: [
		{ id: 'security', source: join(rolesDir, 'security.md') },
		{ id: 'quality', source: join(rolesDir, 'quality.md') },
	],
});

console.log('smoke: running review (two parallel roles)…');
const startedAt = Date.now();
await def.run({ prd: prdPath, cwd });
console.log(`smoke: done in ${Math.round((Date.now() - startedAt) / 1000)}s`);

const runsDir = join(cwd, '.factory', 'runs');
const runId = (await readdir(runsDir)).find((r) => r !== 'latest');
if (!runId) {
	console.error('smoke: no run dir produced');
	process.exit(1);
}
console.log(`smoke: runId=${runId}`);

const findingsPath = join(runsDir, runId, 'findings.json');
console.log(`\n=== merged findings.json (${findingsPath}) ===`);
console.log(await readFile(findingsPath, 'utf8'));

const stepDir = join(runsDir, runId, 'steps', '00-review');
console.log(`\n=== step.json (${stepDir}/step.json) ===`);
console.log(await readFile(join(stepDir, 'step.json'), 'utf8'));

const roleOutputs = await Promise.all(
	['security', 'quality'].map(async (role) => {
		const p = join(stepDir, 'roles', role, 'findings.json');
		try {
			return { role, p, content: await readFile(p, 'utf8') };
		} catch {
			return { role, p, content: '(no findings.json — role failed)' };
		}
	}),
);
for (const { role, p, content } of roleOutputs) {
	console.log(`\n=== role ${role} (${p}) ===`);
	console.log(content);
}
