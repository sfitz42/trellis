// JiraAdapter (PLAN.md §7) and its implementation over the Atlassian CLI. Output is parsed loosely
// (docs/jira-mapping.md, "Principle"): we look for the fields we need and ignore the rest.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AdfDoc } from './adf.js';

export interface RawIssue {
  key: string;
  fields: Record<string, unknown>;
}

export interface ProjectInfo {
  key: string;
  name: string;
  style?: string;
  issueTypes: { id: string; name: string; hierarchyLevel: number }[];
}

export interface CreateInput {
  projectKey: string;
  type: string;
  summary: string;
  description?: AdfDoc;
  labels?: string[];
  assigneeId?: string;
  parentKey?: string;
  dueDate?: string;
}

export interface UpdateInput {
  summary?: string;
  description?: AdfDoc;
  /** account id, or null to unassign */
  assigneeId?: string | null;
  labelsToAdd?: string[];
  labelsToRemove?: string[];
  type?: string;
}

export interface JiraAdapter {
  project(key: string): Promise<ProjectInfo>;
  /** Issue keys matching a JQL query (all pages). */
  searchKeys(jql: string): Promise<string[]>;
  getIssue(key: string): Promise<RawIssue>;
  createIssue(input: CreateInput): Promise<{ key: string }>;
  updateFields(key: string, fields: UpdateInput): Promise<void>;
  transition(key: string, toStatus: string): Promise<void>;
  addLink(fromKey: string, toKey: string, type: string): Promise<void>;
  removeLink(linkId: string): Promise<void>;
  addComment(key: string, body: AdfDoc): Promise<void>;
}

/** Runs `acli` with execFile (never a shell). Injected so tests can record calls. */
export type Runner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

const exec = promisify(execFile);

export const acliRunner: Runner = async (args) => {
  try {
    return await exec('acli', args, { maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string; code?: string };
    if (e.code === 'ENOENT') throw new Error('acli not found on PATH. Install the Atlassian CLI and run `acli jira auth login`.', { cause: err });
    const msg = (e.stderr || e.stdout || e.message).trim().replace(/^✗\s*Error:\s*/m, '');
    throw new Error(`acli ${args.slice(0, 3).join(' ')}: ${msg}`, { cause: err });
  }
};

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`${what}: acli did not return JSON: ${text.slice(0, 200)}`, { cause: err });
  }
}

/** Every `key` that looks like an issue key, anywhere in a search result (shape-agnostic). */
export function keysIn(value: unknown, projectKey: string): string[] {
  const re = new RegExp(`^${projectKey}-\\d+$`);
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o['key'] === 'string' && re.test(o['key'])) out.add(o['key']);
      else Object.values(o).forEach(walk);
    }
  };
  walk(value);
  return [...out];
}

export class AcliAdapter implements JiraAdapter {
  constructor(private readonly projectKey: string, private readonly run: Runner = acliRunner) {}

  private async json(args: string[], what: string): Promise<unknown> {
    const { stdout } = await this.run([...args, '--json']);
    return parseJson(stdout, what);
  }

  /** Write a JSON input file for `--from-json`, run, and clean up. */
  private async withJsonFile<T>(data: unknown, fn: (path: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), 'trellis-acli-'));
    const path = join(dir, 'input.json');
    try {
      await writeFile(path, JSON.stringify(data));
      return await fn(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async project(key: string): Promise<ProjectInfo> {
    const p = (await this.json(['jira', 'project', 'view', '--key', key], 'project view')) as Record<string, unknown>;
    const types = Array.isArray(p['issueTypes']) ? (p['issueTypes'] as Record<string, unknown>[]) : [];
    const info: ProjectInfo = {
      key: typeof p['key'] === 'string' ? p['key'] : key,
      name: typeof p['name'] === 'string' ? p['name'] : key,
      issueTypes: types.map((t) => ({ id: String(t['id'] as string | number), name: typeof t['name'] === 'string' ? t['name'] : '?', hierarchyLevel: Number(t['hierarchyLevel'] ?? 0) })),
    };
    if (typeof p['style'] === 'string') info.style = p['style'];
    return info;
  }

  async searchKeys(jql: string): Promise<string[]> {
    // `--fields` only accepts a fixed set, so search for keys and view each issue separately.
    return keysIn(await this.json(['jira', 'workitem', 'search', '--jql', jql, '--paginate'], 'search'), this.projectKey);
  }

  async getIssue(key: string): Promise<RawIssue> {
    const raw = (await this.json(['jira', 'workitem', 'view', key, '--fields', '*all'], `view ${key}`)) as Partial<RawIssue>;
    if (typeof raw.key !== 'string' || !raw.fields) throw new Error(`view ${key}: unexpected output`);
    return { key: raw.key, fields: raw.fields };
  }

  async createIssue(input: CreateInput): Promise<{ key: string }> {
    let out: unknown;
    if (input.parentKey === undefined) {
      // --from-json: the only way to set the due date at create (additionalAttributes.duedate).
      const data: Record<string, unknown> = { projectKey: input.projectKey, type: input.type, summary: input.summary };
      if (input.description) data['description'] = input.description;
      if (input.labels?.length) data['labels'] = input.labels;
      if (input.assigneeId) data['assignee'] = input.assigneeId;
      if (input.dueDate) data['additionalAttributes'] = { duedate: input.dueDate };
      out = await this.withJsonFile(data, (path) => this.json(['jira', 'workitem', 'create', '--from-json', path], 'create'));
    } else {
      // Flags: `--parent` is verified for epic children; the JSON input's parent is sub-task only.
      const args = ['jira', 'workitem', 'create', '--project', input.projectKey, '--type', input.type, '--summary', input.summary, '--parent', input.parentKey];
      if (input.description) args.push('--description', JSON.stringify(input.description));
      if (input.labels?.length) args.push('--label', input.labels.join(','));
      if (input.assigneeId) args.push('--assignee', input.assigneeId);
      out = await this.json(args, 'create');
    }
    const key = (out as { key?: unknown } | null)?.key ?? keysIn(out, input.projectKey)[0];
    if (typeof key !== 'string') throw new Error('create: no issue key in acli output');
    return { key };
  }

  async updateFields(key: string, f: UpdateInput): Promise<void> {
    const data: Record<string, unknown> = { issues: [key] };
    if (f.summary !== undefined) data['summary'] = f.summary;
    if (f.description !== undefined) data['description'] = f.description;
    if (typeof f.assigneeId === 'string') data['assignee'] = f.assigneeId;
    if (f.labelsToAdd?.length) data['labelsToAdd'] = f.labelsToAdd;
    if (f.labelsToRemove?.length) data['labelsToRemove'] = f.labelsToRemove;
    if (f.type !== undefined) data['type'] = f.type;
    if (Object.keys(data).length > 1) {
      await this.withJsonFile(data, (path) => this.run(['jira', 'workitem', 'edit', '--from-json', path, '--yes', '--json']));
    }
    if (f.assigneeId === null) await this.run(['jira', 'workitem', 'edit', '--key', key, '--remove-assignee', '--yes', '--json']);
  }

  async transition(key: string, toStatus: string): Promise<void> {
    await this.run(['jira', 'workitem', 'transition', '--key', key, '--status', toStatus, '--yes', '--json']);
  }

  /** "fromKey <type> toKey" (e.g. PROJ-1 blocks PROJ-2). */
  async addLink(fromKey: string, toKey: string, type: string): Promise<void> {
    // acli follows Jira's REST naming: the *inward* issue is the one that blocks. Verified on the
    // sandbox: `--out A --in B --type Blocks` creates "B blocks A" (acli's own message says the reverse).
    await this.run(['jira', 'workitem', 'link', 'create', '--out', toKey, '--in', fromKey, '--type', type, '--yes']);
  }

  async removeLink(linkId: string): Promise<void> {
    await this.run(['jira', 'workitem', 'link', 'delete', '--id', linkId, '--yes']);
  }

  async addComment(key: string, body: AdfDoc): Promise<void> {
    await this.run(['jira', 'workitem', 'comment', 'create', '--key', key, '--body', JSON.stringify(body), '--json']);
  }
}
