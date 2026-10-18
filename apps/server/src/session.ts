// The authoritative session (PLAN.md §2, §4–6, §11): state, snapshot, oplog, presence and claims.
// All edits go through @trellis/shared's applyBatch. I/O is limited to the Workspace; network
// delivery is the caller's job (subscribe to events).
import { z } from 'zod';
import {
  applyBatch, computeChangeset, fromSnapshot, planUndo, rebaseOnSnapshot, RoadmapState, Snapshot,
} from '@trellis/shared';
import type {
  Author, Batch, BatchResult, Changeset, Claim, ClientKind, IssueId, OplogEntry, PresenceClient,
  RebaseResult, ServerMessage, SnapshotSummary, Status, UndoPlan,
} from '@trellis/shared';
import { FILES, roadmapMirror, Workspace } from './workspace.js';

export interface SessionOptions {
  workspaceDir: string;
  projectKey?: string | undefined;
  now?: () => Date;
  /** Debounce for roadmap.json / state.json writes (PLAN.md §3: ~500 ms). */
  mirrorDebounceMs?: number;
  defaultClaimTtlSec?: number;
  dragTtlSec?: number;
}

export interface SessionEvent {
  /** A single websocket client id, or null for everyone. */
  to: string | null;
  msg: ServerMessage;
}

/** state.json: the server's own restore file. Embeds the snapshot the session is based on. */
const StateFile = z.object({
  state: RoadmapState,
  baseSnapshot: Snapshot.nullable(),
  batchSeq: z.number().int().nonnegative(),
});

/** How many recent batches a new client receives in `welcome`. */
const RECENT_BATCHES = 100;

export class SessionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409, readonly details?: unknown) {
    super(message);
  }
}

export class Session {
  private listeners = new Set<(e: SessionEvent) => void>();
  private clients = new Map<string, PresenceClient>();
  private claims = new Map<IssueId, Claim>();
  private writeChain: Promise<void> = Promise.resolve();
  private mirrorTimer: NodeJS.Timeout | undefined;
  private readonly now: () => Date;

  private constructor(
    private readonly ws: Workspace,
    private readonly opts: SessionOptions,
    private state: RoadmapState,
    private baseSnapshot: Snapshot | null,
    private diskSnapshot: Snapshot | null,
    private oplog: OplogEntry[],
    private batchSeq: number,
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  // --- boot

  static async load(opts: SessionOptions): Promise<Session> {
    const ws = new Workspace(opts.workspaceDir);
    await ws.ensure();
    const now = opts.now ?? (() => new Date());
    const diskSnapshot = await readSnapshot(ws);
    const saved = await ws.readJson(FILES.state);

    if (saved !== null) {
      const parsed = StateFile.safeParse(saved);
      if (!parsed.success) throw new Error(`${ws.path(FILES.state)} is not a valid Trellis state file: ${parsed.error.message}`);
      const oplog = (await ws.readJsonl(FILES.oplog)) as OplogEntry[];
      return new Session(ws, opts, parsed.data.state, parsed.data.baseSnapshot, diskSnapshot, oplog, parsed.data.batchSeq);
    }

    // No restore file: start fresh from the snapshot (or empty). An old oplog belongs to a
    // previous session, so move it aside rather than mixing histories.
    await ws.moveAside(FILES.oplog, `${now().toISOString().replace(/[:.]/g, '-')}.old`);
    const today = now().toISOString().slice(0, 10);
    const state = diskSnapshot
      ? fromSnapshot(diskSnapshot, { today })
      : fromSnapshot(emptySnapshot(opts.projectKey ?? 'PROJ'), { today });
    const session = new Session(ws, opts, state, diskSnapshot, diskSnapshot, [], 0);
    await session.flush();
    return session;
  }

  // --- events

  subscribe(listener: (e: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(msg: ServerMessage, to: string | null = null): void {
    for (const l of this.listeners) l({ to, msg });
  }

  // --- reads

  getState(): RoadmapState {
    return this.state;
  }

  getOplog(): readonly OplogEntry[] {
    return this.oplog;
  }

  changeset(): Changeset {
    return computeChangeset(this.baseSnapshot ?? emptySnapshot(this.state.project.key), this.state, this.oplog);
  }

  snapshotSummary(): SnapshotSummary {
    const s = this.baseSnapshot;
    return {
      pulledAt: s?.pulledAt ?? null,
      project: s ? { ...s.project } : null,
      epics: s ? Object.keys(s.epics).length : 0,
      tickets: s ? Object.keys(s.tickets).length : 0,
      newerAvailable: this.diskSnapshot !== null && this.diskSnapshot.pulledAt !== (s?.pulledAt ?? null),
    };
  }

  status(): Status {
    this.expireClaims();
    const status: Status = {
      version: this.state.version,
      frozen: this.state.frozen,
      clients: this.presence(),
      claims: this.claimList(),
      snapshot: this.snapshotSummary(),
      pendingChanges: this.changeset().ops.length,
    };
    const key = this.opts.projectKey;
    if (key && this.baseSnapshot && this.baseSnapshot.project.key !== key) {
      status.projectMismatch = `JIRA_PROJECT_KEY is ${key} but the snapshot is from ${this.baseSnapshot.project.key}`;
    }
    return status;
  }

  welcome(): Extract<ServerMessage, { type: 'welcome' }> {
    this.expireClaims();
    return {
      type: 'welcome', state: this.state, snapshot: this.baseSnapshot, snapshotSummary: this.snapshotSummary(),
      recent: this.oplog.slice(-RECENT_BATCHES), presence: this.presence(), claims: this.claimList(), version: this.state.version,
    };
  }

  // --- batches

  /**
   * Validate and apply a batch. `source.clientId` identifies a websocket client, so its own
   * claims don't lock it out; HTTP (CLI) callers are identified by author name.
   */
  submit(batch: Batch, source: { clientId?: string; requestId?: string } = {}): BatchResult {
    this.expireClaims();
    // Every submission gets its own id (rejected ones too), so results are never ambiguous.
    this.batchSeq += 1;
    const id = `b${this.batchSeq}`;
    const locks = new Map<IssueId, string>();
    for (const c of this.claims.values()) {
      const mine = source.clientId !== undefined ? c.clientId === source.clientId : c.holder === batch.author.name && c.clientId === undefined;
      if (!mine) locks.set(c.id, c.holder);
    }
    const out = applyBatch(this.state, batch, { batchId: id, workflow: this.baseSnapshot?.workflow ?? emptySnapshot('X').workflow, locks });

    if (source.requestId !== undefined && source.clientId !== undefined) {
      this.emit({ type: 'batch.result', requestId: source.requestId, results: out.result }, source.clientId);
    }
    if (out.result.applied.length === 0) return out.result;

    this.state = out.state;
    const stored = { ...batch, id };
    const entry: OplogEntry = { batch: stored, result: out.result, at: this.now().toISOString() };
    this.oplog.push(entry);
    this.queueWrite(() => this.ws.appendLine(FILES.oplog, entry));
    this.scheduleMirror();
    this.emit({ type: 'batch.applied', batch: stored, results: out.result, version: this.state.version });
    return out.result;
  }

  undo(batchId: string, author: Author): { plan: UndoPlan; result?: BatchResult } {
    const plan = planUndo(this.oplog, batchId);
    if (!plan.ok) return { plan };
    const result = this.submit({ author, reason: `undo ${batchId}`, atomic: true, ops: plan.ops });
    return { plan, result };
  }

  // --- presence and claims

  hello(clientId: string, name: string, kind: ClientKind): void {
    this.clients.set(clientId, { clientId, name, kind, via: 'ws', selection: [], dragging: null });
    // Deferred so the new client's `welcome` (sent right after hello) arrives before this.
    queueMicrotask(() => { this.emitPresence(); });
  }

  disconnect(clientId: string): void {
    if (!this.clients.delete(clientId)) return;
    let released = false;
    for (const [id, c] of this.claims) {
      if (c.clientId === clientId) {
        this.claims.delete(id);
        released = true;
      }
    }
    this.emitPresence();
    if (released) this.emitClaims();
  }

  updatePresence(clientId: string, update: { selection?: IssueId[] | undefined; dragging?: IssueId | null | undefined }): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    if (update.selection !== undefined) client.selection = [...update.selection];
    if (update.dragging !== undefined && update.dragging !== client.dragging) {
      // Dragging is a soft lock for others (PLAN.md §5): a short-lived "drag" claim.
      for (const [id, c] of this.claims) if (c.clientId === clientId && c.kind === 'drag') this.claims.delete(id);
      client.dragging = update.dragging;
      if (update.dragging !== null) {
        this.tryClaim([update.dragging], { holder: client.name, clientId, kind: 'drag', ttlSec: this.opts.dragTtlSec ?? 10 });
      }
      this.emitClaims();
    }
    this.emitPresence();
  }

  claim(ids: IssueId[], by: { holder: string; clientId?: string; note?: string; ttlSec?: number }): { ok: true; claims: Claim[] } | { ok: false; conflicts: Claim[] } {
    this.expireClaims();
    const res = this.tryClaim(ids, { ...by, kind: 'claim', ttlSec: by.ttlSec ?? this.opts.defaultClaimTtlSec ?? 300 });
    if (!res.ok) return res;
    this.emitClaims();
    this.emitPresence();
    return { ok: true, claims: this.claimList() };
  }

  release(ids: IssueId[], by: { holder: string; clientId?: string }): Claim[] {
    for (const id of ids) {
      const c = this.claims.get(id);
      if (c && (by.clientId !== undefined ? c.clientId === by.clientId : c.holder === by.holder && c.clientId === undefined)) this.claims.delete(id);
    }
    this.emitClaims();
    this.emitPresence();
    return this.claimList();
  }

  /** Drop expired claims; returns true (and notifies) if any expired. Called on a timer too. */
  expireClaims(): boolean {
    const now = this.now().getTime();
    let changed = false;
    for (const [id, c] of this.claims) {
      if (Date.parse(c.expiresAt) <= now) {
        this.claims.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.emitClaims();
      this.emitPresence();
    }
    return changed;
  }

  private tryClaim(ids: IssueId[], by: { holder: string; clientId?: string | undefined; note?: string | undefined; ttlSec: number; kind: Claim['kind'] }): { ok: true } | { ok: false; conflicts: Claim[] } {
    const isMine = (c: Claim): boolean => (by.clientId !== undefined ? c.clientId === by.clientId : c.holder === by.holder && c.clientId === undefined);
    const conflicts = ids.flatMap((id) => {
      const c = this.claims.get(id);
      return c && !isMine(c) ? [c] : [];
    });
    if (conflicts.length > 0) return { ok: false, conflicts };
    const expiresAt = new Date(this.now().getTime() + by.ttlSec * 1000).toISOString();
    for (const id of ids) {
      const c: Claim = { id, holder: by.holder, kind: by.kind, expiresAt };
      if (by.clientId !== undefined) c.clientId = by.clientId;
      if (by.note !== undefined) c.note = by.note;
      this.claims.set(id, c);
    }
    return { ok: true };
  }

  private claimList(): Claim[] {
    return [...this.claims.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Websocket clients, plus HTTP (CLI) agents for as long as they hold a claim (PLAN.md §8). */
  private presence(): PresenceClient[] {
    const out = [...this.clients.values()];
    const httpHolders = new Set([...this.claims.values()].filter((c) => c.clientId === undefined).map((c) => c.holder));
    for (const name of httpHolders) out.push({ clientId: `http:${name}`, name, kind: 'agent', via: 'http', selection: [], dragging: null });
    return out;
  }

  private emitPresence(): void {
    this.emit({ type: 'presence', clients: this.presence() });
  }

  private emitClaims(): void {
    this.emit({ type: 'claims', claims: this.claimList() });
  }

  // --- freeze

  async freeze(by: string): Promise<Changeset> {
    if (this.state.frozen) throw new SessionError('FROZEN', `already frozen by ${this.state.frozen.by}`);
    const frozen = { by, at: this.now().toISOString() };
    this.state = { ...this.state, frozen };
    const changeset = this.changeset();
    await this.ws.writeJson(FILES.lock, { ...frozen, version: this.state.version });
    await this.ws.writeJson(FILES.changeset, changeset);
    await this.flush();
    this.emit({ type: 'freeze', frozen, changeset });
    return changeset;
  }

  async unfreeze(): Promise<void> {
    if (!this.state.frozen) throw new SessionError('NOT_FROZEN', 'the session is not frozen');
    this.state = { ...this.state, frozen: null };
    await this.ws.remove(FILES.lock);
    await this.flush();
    this.emit({ type: 'freeze', frozen: null, changeset: null });
  }

  // --- snapshot reload

  /** Rebase onto workspace/snapshot.json (PLAN.md §6 step 4). */
  async reloadSnapshot(): Promise<{ summary: SnapshotSummary } & Omit<RebaseResult, 'state'>> {
    const next = await readSnapshot(this.ws);
    if (!next) throw new SessionError('NO_SNAPSHOT', `${this.ws.path(FILES.snapshot)} not found`, 404);
    const tempIds = tempIdsFromApplyLog(await this.ws.readJson(FILES.applyLog).catch(() => null));
    const { state, ...info } = rebaseOnSnapshot(this.state, this.baseSnapshot, next, tempIds);
    this.state = state;
    this.baseSnapshot = next;
    this.diskSnapshot = next;
    if (this.state.frozen) await this.ws.writeJson(FILES.changeset, this.changeset());
    await this.flush();
    const summary = this.snapshotSummary();
    this.emit({ type: 'snapshot.reloaded', summary, state: this.state, snapshot: next });
    return { summary, ...info };
  }

  /** A watched file changed on disk. */
  async onFileChanged(name: string): Promise<void> {
    if (name === FILES.snapshot) {
      this.diskSnapshot = await readSnapshot(this.ws).catch(() => this.diskSnapshot);
      if (!this.snapshotSummary().newerAvailable) return;
      // While frozen this is the post-apply re-pull: reload straight away. Otherwise ask.
      if (this.state.frozen) await this.reloadSnapshot();
      else this.emit({ type: 'snapshot.available', summary: this.snapshotSummary() });
    } else if (name === FILES.applyLog) {
      const log = await this.ws.readJson(FILES.applyLog).catch(() => null);
      if (log !== null) this.emit({ type: 'apply.progress', log });
    }
  }

  // --- persistence

  private queueWrite(fn: () => Promise<void>): void {
    this.writeChain = this.writeChain.then(fn, fn);
  }

  private scheduleMirror(): void {
    clearTimeout(this.mirrorTimer);
    this.mirrorTimer = setTimeout(() => { void this.flush(); }, this.opts.mirrorDebounceMs ?? 500);
  }

  /** Write state.json and roadmap.json now (and wait for queued oplog appends). */
  async flush(): Promise<void> {
    clearTimeout(this.mirrorTimer);
    this.mirrorTimer = undefined;
    const state = this.state;
    const file = { state, baseSnapshot: this.baseSnapshot, batchSeq: this.batchSeq };
    this.queueWrite(async () => {
      await this.ws.writeJson(FILES.state, file);
      await this.ws.writeAtomic(FILES.roadmap, roadmapMirror(state));
    });
    await this.writeChain;
  }
}

async function readSnapshot(ws: Workspace): Promise<Snapshot | null> {
  const raw = await ws.readJson(FILES.snapshot);
  if (raw === null) return null;
  const parsed = Snapshot.safeParse(raw);
  if (!parsed.success) throw new Error(`${ws.path(FILES.snapshot)} is not a valid snapshot: ${parsed.error.message}`);
  return parsed.data;
}

function emptySnapshot(projectKey: string): Snapshot {
  return {
    pulledAt: '',
    project: { key: projectKey, name: '' },
    epics: {},
    tickets: {},
    workflow: { epicIssueType: 'Epic', statuses: {}, transitions: null, assignableUsers: [] },
  };
}

/**
 * NEW-* → real key from apply-log.json. The log's format belongs to Phase 5, so read it loosely:
 * any entry (in an array, or under `entries`) with a NEW-* `target`/`tempId` and a created key.
 */
export function tempIdsFromApplyLog(log: unknown): Record<IssueId, IssueId> {
  const entries = Array.isArray(log) ? log : (log as { entries?: unknown } | null)?.entries;
  const out: Record<IssueId, IssueId> = {};
  if (!Array.isArray(entries)) return out;
  for (const e of entries as Record<string, unknown>[]) {
    const temp = [e['tempId'], e['target']].find((v): v is string => typeof v === 'string' && /^NEW-\d+$/.test(v));
    const key = [e['createdKey'], e['key']].find((v): v is string => typeof v === 'string' && /^[A-Z][A-Z0-9_]*-\d+$/.test(v) && !v.startsWith('NEW-'));
    if (temp && key) out[temp] = key;
  }
  return out;
}
