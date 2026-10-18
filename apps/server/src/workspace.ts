// File I/O for ./workspace (PLAN.md §11). Writes are atomic: temp file + rename.
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { compareIds } from '@trellis/shared';
import type { RoadmapState } from '@trellis/shared';

export const FILES = {
  snapshot: 'snapshot.json',
  roadmap: 'roadmap.json',
  state: 'state.json',
  oplog: 'oplog.jsonl',
  changeset: 'changeset.json',
  applyPlan: 'apply-plan.json',
  applyLog: 'apply-log.json',
  driftDecisions: 'drift-decisions.json',
  lock: '.lock',
} as const;

export class Workspace {
  constructor(readonly dir: string) {}

  path(name: string): string {
    return join(this.dir, name);
  }

  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /** Parsed JSON, or `null` if the file doesn't exist. Throws with the path on bad JSON. */
  async readJson(name: string): Promise<unknown> {
    const text = await this.readText(name);
    if (text === null) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new Error(`${this.path(name)} is not valid JSON: ${(err as Error).message}`, { cause: err });
    }
  }

  async readText(name: string): Promise<string | null> {
    try {
      return await readFile(this.path(name), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async writeAtomic(name: string, text: string): Promise<void> {
    const target = this.path(name);
    const tmp = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    await writeFile(tmp, text);
    await rename(tmp, target);
  }

  async writeJson(name: string, data: unknown): Promise<void> {
    await this.writeAtomic(name, `${JSON.stringify(data, null, 2)}\n`);
  }

  async appendLine(name: string, data: unknown): Promise<void> {
    await appendFile(this.path(name), `${JSON.stringify(data)}\n`);
  }

  async readJsonl(name: string): Promise<unknown[]> {
    const text = await this.readText(name);
    if (!text) return [];
    return text.split('\n').filter((l) => l.trim() !== '').map((l, i) => {
      try {
        return JSON.parse(l) as unknown;
      } catch (err) {
        throw new Error(`${this.path(name)} line ${i + 1} is not valid JSON`, { cause: err });
      }
    });
  }

  async remove(name: string): Promise<void> {
    await rm(this.path(name), { force: true });
  }

  async moveAside(name: string, suffix: string): Promise<void> {
    if ((await this.readText(name)) === null) return;
    await rename(this.path(name), this.path(`${name}.${suffix}`));
  }
}

/**
 * roadmap.json: the state without `meta`, with stable key order so diffs of the file are
 * readable (sorted keys; epics and tickets by id, numerically).
 */
export function roadmapMirror(state: RoadmapState): string {
  const { meta: _meta, ...rest } = state;
  return `${JSON.stringify(sortKeys(rest), null, 2)}\n`;
}

function sortKeys(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => sortKeys(v));
  if (value === null || typeof value !== 'object') return value;
  const byId = parentKey === 'epics' || parentKey === 'tickets';
  const keys = Object.keys(value).sort(byId ? compareIds : undefined);
  return Object.fromEntries(keys.map((k) => [k, sortKeys((value as Record<string, unknown>)[k], k)]));
}
