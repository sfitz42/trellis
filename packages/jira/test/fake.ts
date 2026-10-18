// An in-memory Jira behind the JiraAdapter interface, shaped like acli's `view --json` output.
import { readFileSync } from 'node:fs';
import { Snapshot } from '@trellis/shared';
import { markdownToAdf } from '../src/adf.js';
import type { AdfDoc } from '../src/adf.js';
import type { CreateInput, JiraAdapter, ProjectInfo, RawIssue, UpdateInput } from '../src/adapter.js';

export const fixture = (): Snapshot =>
  Snapshot.parse(JSON.parse(readFileSync(new URL('../../shared/fixtures/snapshot.sample.json', import.meta.url), 'utf8')));

const CATEGORY: Record<string, string> = { 'To Do': 'new', 'In Progress': 'indeterminate', Done: 'done' };
const LEVEL: Record<string, number> = { Epic: 1, Story: 0, Task: 0, Bug: 0, Feature: 0, Subtask: -1 };

export class FakeJira implements JiraAdapter {
  issues = new Map<string, RawIssue>();
  calls: string[] = [];
  comments: { key: string; body: AdfDoc }[] = [];
  people = new Map<string, string>();
  private next = 500;
  private nextLink = 30000;
  /** Throw on the first call matching this (to test resume). */
  failOnce: ((call: string) => boolean) | null = null;

  constructor(readonly key = 'PROJ', readonly name = 'Platform Rebuild') {}

  /** Jira as described by a Trellis snapshot (the fixture), with links on both sides. */
  static fromSnapshot(s: Snapshot): FakeJira {
    const j = new FakeJira(s.project.key, s.project.name);
    for (const e of Object.values(s.epics)) {
      j.issues.set(e.id, j.raw(e.id, 'Epic', e.summary, e.status, { duedate: e.dueDate, description: e.description ? markdownToAdf(e.description) : null }));
    }
    for (const t of Object.values(s.tickets)) {
      if (t.assignee) j.people.set(t.assignee.accountId, t.assignee.displayName);
      j.issues.set(t.id, j.raw(t.id, t.issueType, t.summary, t.status, {
        parent: t.epicId ? { id: '1', key: t.epicId, self: 'x', fields: { summary: s.epics[t.epicId]?.summary } } : undefined,
        assignee: t.assignee ? { accountId: t.assignee.accountId, displayName: t.assignee.displayName, active: true } : null,
        labels: [...t.labels],
        description: t.description ? markdownToAdf(t.description) : null,
        issuelinks: t.links.map((l) => ({ id: l.jiraLinkId, self: 'x', type: { id: '1', name: l.type, inward: 'is blocked by', outward: 'blocks' }, [l.direction === 'outward' ? 'outwardIssue' : 'inwardIssue']: { key: l.target } })),
      }));
    }
    return j;
  }

  raw(key: string, type: string, summary: string, status: string, extra: Record<string, unknown> = {}): RawIssue {
    return {
      key,
      fields: {
        summary,
        issuetype: { id: '1', name: type, hierarchyLevel: LEVEL[type] ?? 0, subtask: type === 'Subtask' },
        status: { name: status, statusCategory: { key: CATEGORY[status] ?? 'new', name: status } },
        labels: [],
        issuelinks: [],
        customfield_10015: null, // noise every real issue has
        customfield_10019: '0|i0000:',
        ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)),
      },
    };
  }

  private log(call: string): void {
    this.calls.push(call);
    if (this.failOnce?.(call)) {
      this.failOnce = null;
      throw new Error(`simulated failure: ${call}`);
    }
  }

  private get(key: string): RawIssue {
    const i = this.issues.get(key);
    if (!i) throw new Error(`issue ${key} does not exist`);
    return i;
  }

  project(): Promise<ProjectInfo> {
    return Promise.resolve({ key: this.key, name: this.name, style: 'next-gen', issueTypes: Object.entries(LEVEL).map(([name, hierarchyLevel], i) => ({ id: String(i), name, hierarchyLevel })) });
  }

  searchKeys(): Promise<string[]> {
    return Promise.resolve([...this.issues.keys()]);
  }

  getIssue(key: string): Promise<RawIssue> {
    return Promise.resolve(structuredClone(this.get(key)));
  }

  createIssue(input: CreateInput): Promise<{ key: string }> {
    this.log(`create ${input.type} ${input.summary}`);
    const key = `${this.key}-${this.next++}`;
    this.issues.set(key, this.raw(key, input.type, input.summary, 'To Do', {
      parent: input.parentKey ? { key: input.parentKey } : undefined,
      duedate: input.dueDate,
      labels: input.labels ?? [],
      assignee: input.assigneeId ? { accountId: input.assigneeId, displayName: this.people.get(input.assigneeId) ?? input.assigneeId } : null,
      description: input.description ?? null,
    }));
    return Promise.resolve({ key });
  }

  updateFields(key: string, f: UpdateInput): Promise<void> {
    this.log(`update ${key} ${Object.keys(f).join(',')}`);
    const i = this.get(key);
    if (f.summary !== undefined) i.fields['summary'] = f.summary;
    if (f.description !== undefined) i.fields['description'] = f.description;
    if (f.assigneeId !== undefined) i.fields['assignee'] = f.assigneeId ? { accountId: f.assigneeId, displayName: this.people.get(f.assigneeId) ?? f.assigneeId } : null;
    if (f.type !== undefined) (i.fields['issuetype'] as Record<string, unknown>)['name'] = f.type;
    if (f.labelsToAdd || f.labelsToRemove) {
      const labels = new Set(i.fields['labels'] as string[]);
      for (const l of f.labelsToAdd ?? []) labels.add(l);
      for (const l of f.labelsToRemove ?? []) labels.delete(l);
      i.fields['labels'] = [...labels];
    }
    return Promise.resolve();
  }

  transition(key: string, status: string): Promise<void> {
    this.log(`transition ${key} ${status}`);
    if (!CATEGORY[status]) return Promise.reject(new Error(`no transition to "${status}"`));
    this.get(key).fields['status'] = { name: status, statusCategory: { key: CATEGORY[status] } };
    return Promise.resolve();
  }

  addLink(from: string, to: string, type: string): Promise<void> {
    this.log(`link ${from} ${type} ${to}`);
    const id = String(this.nextLink++);
    (this.get(from).fields['issuelinks'] as unknown[]).push({ id, type: { name: type }, outwardIssue: { key: to } });
    (this.get(to).fields['issuelinks'] as unknown[]).push({ id, type: { name: type }, inwardIssue: { key: from } });
    return Promise.resolve();
  }

  removeLink(linkId: string): Promise<void> {
    this.log(`unlink ${linkId}`);
    for (const i of this.issues.values()) i.fields['issuelinks'] = (i.fields['issuelinks'] as { id?: string }[]).filter((l) => l.id !== linkId);
    return Promise.resolve();
  }

  addComment(key: string, body: AdfDoc): Promise<void> {
    this.log(`comment ${key}`);
    this.get(key);
    this.comments.push({ key, body });
    return Promise.resolve();
  }
}
