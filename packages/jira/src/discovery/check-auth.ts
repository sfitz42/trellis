// Confirms acli is installed and logged in to JIRA_SITE. Read-only.
import { loadJiraEnv } from '../env.js';
import { acli } from './acli.js';

const env = loadJiraEnv();

const { stdout: version } = await acli(['--version']).catch(() => {
  console.error('acli not found on PATH. Install the Atlassian CLI first.');
  process.exit(1);
});
console.log(version.trim());

let status: string;
try {
  const { stdout, stderr } = await acli(['jira', 'auth', 'status']);
  status = stdout + stderr;
} catch (err) {
  console.error(`acli is not authenticated: ${(err as Error).message}`);
  console.error('Run: acli jira auth login --web   (choose the site in JIRA_SITE)');
  process.exit(1);
}

if (!status.includes(env.JIRA_SITE)) {
  console.error('acli is logged in, but not to the site in JIRA_SITE. Status was:\n' + status);
  console.error('Run: acli jira auth switch   (or log in to the right site)');
  process.exit(1);
}
console.log('acli is authenticated for JIRA_SITE.');
