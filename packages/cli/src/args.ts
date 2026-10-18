// Parsing and resolving CLI arguments: dates, shifts, durations, people, ops from stdin.
import { Batch, IsoDate, Op } from '@trellis/shared';
import type { Person, RoadmapState } from '@trellis/shared';
import { z } from 'zod';
import { CliError, EXIT } from './errors.js';

const usage = (msg: string): CliError => new CliError(EXIT.usage, msg);

/** `YYYY-MM-DD`, or `none` to clear. */
export function parseDate(value: string, flag: string): string | null {
  if (value === 'none' || value === 'null') return null;
  const r = IsoDate.safeParse(value);
  if (!r.success) throw usage(`${flag} must be YYYY-MM-DD or "none", got "${value}"`);
  return r.data;
}

/** `30s`, `5m`, `1h` → seconds. */
export function parseTtl(value: string): number {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(value.trim());
  if (!m) throw usage(`--ttl must look like 30s, 5m or 1h, got "${value}"`);
  const n = Number(m[1]);
  return m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
}

export interface Shift {
  n: number;
  unit: 'd' | 'w' | 'm' | 'q';
}

/** `+1m`, `-2w`, `1q`, `10d`. */
export function parseShift(value: string): Shift {
  const m = /^([+-]?\d+)([dwmq])$/.exec(value.trim());
  if (!m) throw usage(`--shift must look like 1m, -2w, 1q or 10d, got "${value}"`);
  return { n: Number(m[1]), unit: m[2] as Shift['unit'] };
}

function lastDay(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

/** Shift a date; a month-end date stays a month-end date (2027-02-28 +1m → 2027-03-31). */
export function shiftDate(date: string, s: Shift): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (s.unit === 'd' || s.unit === 'w') {
    d.setUTCDate(d.getUTCDate() + s.n * (s.unit === 'w' ? 7 : 1));
    return d.toISOString().slice(0, 10);
  }
  const months = s.n * (s.unit === 'q' ? 3 : 1);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const wasEnd = day === lastDay(y, m);
  const target = new Date(Date.UTC(y, m + months, 1));
  const end = lastDay(target.getUTCFullYear(), target.getUTCMonth());
  target.setUTCDate(wasEnd ? end : Math.min(day, end));
  return target.toISOString().slice(0, 10);
}

/** Everyone the roadmap knows about (assignees), for resolving `--assignee`. */
export function knownPeople(state: RoadmapState): Person[] {
  const map = new Map<string, Person>();
  for (const t of Object.values(state.tickets)) if (t.assignee) map.set(t.assignee.accountId, t.assignee);
  return [...map.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Resolve `--assignee` by account id, exact name, or a unique name prefix. `none` unassigns. */
export function resolvePerson(value: string, state: RoadmapState): Person | null {
  if (value === 'none') return null;
  const people = knownPeople(state);
  const v = value.toLowerCase();
  const found =
    people.find((p) => p.accountId === value) ??
    people.find((p) => p.displayName.toLowerCase() === v) ??
    (() => {
      const prefix = people.filter((p) => p.displayName.toLowerCase().startsWith(v));
      return prefix.length === 1 ? prefix[0] : undefined;
    })();
  if (!found) {
    throw usage(`unknown assignee "${value}". Known people: ${people.map((p) => `${p.displayName} (${p.accountId})`).join(', ') || 'none yet'}`);
  }
  return found;
}

export function parseList(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

export function parseNumberOrNone(value: string, flag: string): number | null {
  if (value === 'none') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw usage(`${flag} must be a non-negative number or "none", got "${value}"`);
  return n;
}

const OpsInput = z.union([z.array(Op), z.object({ ops: z.array(Op) }).loose()]);

/**
 * Ops for `trellis batch` from stdin: a JSON array of ops, `{ "ops": [...] }`, or a whole batch
 * (its reason/askedBy/baseVersion/atomic are used unless flags override them).
 */
/** Batch fields `trellis batch` may take from its JSON input. */
export interface BatchHints {
  reason?: string | undefined;
  askedBy?: string | undefined;
  baseVersion?: number | undefined;
  atomic?: boolean | undefined;
}

export function parseOpsInput(text: string): { ops: Op[]; batch: BatchHints } {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw usage('stdin must be JSON: an array of ops, or {"ops": [...]}');
  }
  const r = OpsInput.safeParse(data);
  if (!r.success) throw usage(`invalid ops:\n${z.prettifyError(r.error)}`);
  if (Array.isArray(r.data)) return { ops: r.data, batch: {} };
  const hints = Batch.pick({ reason: true, askedBy: true, baseVersion: true, atomic: true }).partial().loose().safeParse(data);
  return { ops: r.data.ops, batch: hints.success ? hints.data : {} };
}
