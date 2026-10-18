// `pnpm seed`: put the sanitised fixture snapshot in the workspace, to try Trellis without Jira.
// Refuses to overwrite an existing snapshot unless --force (it may be a real pull).
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspacePath } from './env.js';
import { readJson } from './files.js';

const fixture = fileURLToPath(new URL('../../shared/fixtures/snapshot.sample.json', import.meta.url));
const dir = workspacePath();
const target = join(dir, 'snapshot.json');
const force = process.argv.includes('--force');

await mkdir(dir, { recursive: true });
if (!force && (await readJson(target)) !== null) {
  console.error(`${target} already exists (maybe a real Jira pull). Use \`pnpm seed --force\` to replace it.`);
  process.exit(1);
}
await copyFile(fixture, target);
console.log(`Seeded ${target} with the sample project (5 epics, 36 tickets, invented data).`);
if ((await readJson(join(dir, 'state.json'))) !== null) {
  console.log('A session already exists: a running server will offer "New Jira snapshot · reload".');
}
