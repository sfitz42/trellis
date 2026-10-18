// Captures `acli … --help` for every command a JiraAdapter method could use.
// Help only: no command here ever touches Jira. Output: workspace/discovery/help/*.txt
import { mkdir, writeFile } from 'node:fs/promises';
import { workspacePath } from '../env.js';
import { acli } from './acli.js';

const COMMANDS: string[][] = [
  ['jira', 'auth', 'status'],
  ['jira', 'auth', 'login'],
  ['jira', 'project', 'view'],
  ['jira', 'project', 'list'],
  ['jira', 'field'],
  ['jira', 'filter'],
  ['jira', 'workitem', 'search'],
  ['jira', 'workitem', 'view'],
  ['jira', 'workitem', 'create'],
  ['jira', 'workitem', 'create-bulk'],
  ['jira', 'workitem', 'edit'],
  ['jira', 'workitem', 'assign'],
  ['jira', 'workitem', 'transition'],
  ['jira', 'workitem', 'link'],
  ['jira', 'workitem', 'link', 'create'],
  ['jira', 'workitem', 'link', 'delete'],
  ['jira', 'workitem', 'link', 'list'],
  ['jira', 'workitem', 'link', 'type'],
  ['jira', 'workitem', 'comment'],
  ['jira', 'workitem', 'comment', 'create'],
  ['jira', 'workitem', 'comment', 'list'],
];

const outDir = `${workspacePath()}/discovery/help`;
await mkdir(outDir, { recursive: true });

for (const cmd of COMMANDS) {
  const name = cmd.slice(1).join('-');
  try {
    const { stdout, stderr } = await acli([...cmd, '--help']);
    const text = stdout + stderr;
    await writeFile(`${outDir}/${name}.txt`, text);
    console.log(`${name.padEnd(28)} json=${/--json\b/.test(text) ? 'yes' : 'no '}  ${text.split('\n')[0] ?? ''}`);
  } catch (err) {
    console.log(`${name.padEnd(28)} MISSING  ${(err as Error).message.split('\n')[0] ?? ''}`);
  }
}
