// The live session as seen by this browser: websocket, optimistic edits, presence, claims,
// activity and agent batches. Components read its $state fields and call its methods.
import type {
  Batch, BatchResult, Changeset, Claim, IssueId, Op, OplogEntry, PresenceClient, RoadmapState, ServerMessage,
  Snapshot, SnapshotSummary,
} from '@trellis/shared';
import { changesetFor, idsOfOp } from './items.js';
import { OptimisticModel } from './optimistic.js';

export interface Notice {
  id: number;
  kind: 'error' | 'info';
  text: string;
}

/** How long agent-touched items keep their plum outline (PLAN.md §9: ~30 s). */
export const AGENT_HIGHLIGHT_MS = 30_000;

const rid = (): string => Math.random().toString(36).slice(2, 10);

function storage(kind: 'local' | 'session'): Storage | null {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export class Live {
  connection = $state<'connecting' | 'open' | 'closed'>('connecting');
  state = $state.raw<RoadmapState | null>(null);
  snapshot = $state.raw<Snapshot | null>(null);
  summary = $state.raw<SnapshotSummary | null>(null);
  presence = $state.raw<PresenceClient[]>([]);
  claims = $state.raw<Claim[]>([]);
  oplog = $state.raw<OplogEntry[]>([]);
  /** The latest agent batch, while its banner is showing. */
  agentBatch = $state.raw<OplogEntry | null>(null);
  /** Items an agent touched → when the highlight ends (ms since epoch). */
  agentTouched = $state.raw<Map<IssueId, number>>(new Map());
  notices = $state<Notice[]>([]);
  snapshotAvailable = $state.raw<SnapshotSummary | null>(null);
  applyLog = $state.raw<unknown>(null);
  /** Changeset written at freeze time (server's copy). */
  frozenChangeset = $state.raw<Changeset | null>(null);
  /** Set when a re-pull arrived while frozen (step 4 of the freeze screen). */
  repulledAt = $state<string | null>(null);

  readonly changeset = $derived(this.state ? changesetFor(this.snapshot, this.state, this.oplog) : null);

  name: string;
  readonly clientId: string;
  private model: OptimisticModel | null = null;
  private ws: WebSocket | null = null;
  private retry = 0;
  private noticeSeq = 0;
  private stopped = false;

  constructor(name: string) {
    this.name = name;
    const ss = storage('session');
    this.clientId = ss?.getItem('trellis.clientId') ?? `web-${rid()}`;
    ss?.setItem('trellis.clientId', this.clientId);
  }

  static savedName(): string | null {
    return storage('local')?.getItem('trellis.name') ?? null;
  }

  static saveName(name: string): void {
    storage('local')?.setItem('trellis.name', name);
  }

  /** The roadmap; only call once connected (components render after the first welcome). */
  get roadmap(): RoadmapState {
    if (!this.state) throw new Error('roadmap not loaded yet');
    return this.state;
  }

  get me(): { name: string; kind: 'human' } {
    return { name: this.name, kind: 'human' };
  }

  // --- connection

  connect(): void {
    this.stopped = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    this.connection = 'connecting';
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ type: 'hello', name: this.name, kind: 'human', clientId: this.clientId }));
    };
    ws.onmessage = (ev: MessageEvent<string>) => {
      this.onMessage(JSON.parse(ev.data) as ServerMessage);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.connection = 'closed';
      if (this.stopped) return;
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => { if (!this.stopped) this.connect(); }, delay);
    };
  }

  disconnect(): void {
    this.stopped = true;
    this.ws?.close();
  }

  /** Drop local state and get a fresh welcome (used when this client drifted from the server). */
  private resync(): void {
    this.notify('info', 'Re-syncing with the server…');
    this.ws?.close();
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private refresh(): void {
    if (this.model) this.state = this.model.view();
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        this.model = new OptimisticModel(msg.state, msg.snapshot?.workflow);
        this.snapshot = msg.snapshot;
        this.summary = msg.snapshotSummary;
        this.oplog = msg.recent;
        this.presence = msg.presence;
        this.claims = msg.claims;
        this.snapshotAvailable = msg.snapshotSummary.newerAvailable ? msg.snapshotSummary : null;
        this.connection = 'open';
        this.refresh();
        break;
      case 'batch.result': {
        const res = this.model?.result(msg.requestId, msg.results);
        if (res) this.explain(res);
        this.refresh();
        break;
      }
      case 'batch.applied': {
        if (!this.model) break;
        if (!this.model.applyRemote(msg.batch, msg.results, msg.version)) {
          this.resync();
          break;
        }
        const entry: OplogEntry = { batch: msg.batch, result: msg.results, at: new Date().toISOString() };
        this.oplog = [...this.oplog, entry].slice(-200);
        if (msg.batch.author.kind === 'agent') this.showAgentBatch(entry);
        this.refresh();
        break;
      }
      case 'presence':
        this.presence = msg.clients;
        break;
      case 'claims':
        this.claims = msg.claims;
        break;
      case 'freeze':
        this.frozenChangeset = msg.changeset;
        if (msg.frozen === null) this.repulledAt = null;
        if (this.model) {
          this.model.replaceConfirmed({ ...this.model.confirmed, frozen: msg.frozen });
          this.refresh();
        }
        break;
      case 'snapshot.available':
        this.snapshotAvailable = msg.summary;
        break;
      case 'snapshot.reloaded':
        this.snapshot = msg.snapshot;
        this.summary = msg.summary;
        this.snapshotAvailable = null;
        if (msg.state.frozen) this.repulledAt = new Date().toISOString();
        this.model?.reset(msg.state, msg.snapshot.workflow);
        this.refresh();
        break;
      case 'apply.progress':
        this.applyLog = msg.log;
        break;
      case 'error':
        this.notify('error', `${msg.code}: ${msg.message}`);
        break;
    }
  }

  private explain(res: BatchResult): void {
    for (const r of res.rejected) if (r.code !== 'BATCH_REJECTED') this.notify('error', `Not applied: ${r.message}`);
    for (const s of res.skipped) this.notify('info', `Kept newer edit: ${s.message}`);
  }

  private showAgentBatch(entry: OplogEntry): void {
    this.agentBatch = entry;
    const until = Date.now() + AGENT_HIGHLIGHT_MS;
    const touched = new Map(this.agentTouched);
    for (const a of entry.result.applied) for (const id of idsOfOp(a.op, a.createdId)) touched.set(id, until);
    this.agentTouched = touched;
    setTimeout(() => {
      const now = Date.now();
      this.agentTouched = new Map([...this.agentTouched].filter(([, t]) => t > now));
    }, AGENT_HIGHLIGHT_MS + 50);
  }

  notify(kind: Notice['kind'], text: string): void {
    const id = ++this.noticeSeq;
    this.notices = [...this.notices, { id, kind, text }].slice(-4);
    setTimeout(() => { this.dismiss(id); }, kind === 'error' ? 8000 : 5000);
  }

  dismiss(id: number): void {
    this.notices = this.notices.filter((n) => n.id !== id);
  }

  // --- edits

  /** Apply ops optimistically and send them as one batch (browser batches are non-atomic). */
  submit(ops: Op[], opts: { atomic?: boolean } = {}): void {
    if (!this.model || ops.length === 0) return;
    if (this.state?.frozen) {
      this.notify('error', `Frozen by ${this.state.frozen.by}: editing is locked`);
      return;
    }
    const batch: Batch = { author: this.me, atomic: opts.atomic ?? false, baseVersion: this.model.confirmed.version, ops };
    const requestId = rid();
    this.model.submit(requestId, batch);
    this.refresh();
    this.send({ type: 'batch', requestId, batch });
  }

  setSelection(ids: IssueId[]): void {
    this.send({ type: 'presence', selection: ids });
  }

  setDragging(id: IssueId | null): void {
    this.send({ type: 'presence', dragging: id });
  }

  /** Who else (not me) holds a claim on this id. */
  lockedBy(id: IssueId): Claim | undefined {
    return this.claims.find((c) => c.id === id && c.clientId !== this.clientId);
  }

  /** Other people currently looking at (selected) this id. */
  viewersOf(id: IssueId): PresenceClient[] {
    return this.presence.filter((p) => p.clientId !== this.clientId && p.selection.includes(id));
  }

  isAgentTouched(id: IssueId): boolean {
    return (this.agentTouched.get(id) ?? 0) > Date.now();
  }

  // --- HTTP actions

  private async post(path: string, body?: unknown): Promise<unknown> {
    const init: RequestInit = { method: 'POST' };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { 'content-type': 'application/json' };
    }
    const res = await fetch(path, init);
    const data = (await res.json()) as unknown;
    if (!res.ok) {
      const err = data as { message?: string };
      this.notify('error', err.message ?? `${path} failed (${res.status})`);
      throw new Error(err.message ?? path);
    }
    return data;
  }

  undo(batchId: string): Promise<unknown> {
    return this.post('/api/undo', { batchId, author: this.me });
  }

  freeze(): Promise<unknown> {
    return this.post('/api/freeze', { by: this.name });
  }

  unfreeze(): Promise<unknown> {
    return this.post('/api/unfreeze');
  }

  reloadSnapshot(): Promise<unknown> {
    return this.post('/api/snapshot/reload');
  }
}
