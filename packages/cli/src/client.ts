// HTTP client for the server API (PLAN.md §5).
import type { ApiError, Author, Batch, BatchResult, Changeset, Claim, Epic, RoadmapState, Status, Ticket } from '@trellis/shared';
import { CliError, EXIT } from './errors.js';

export interface CliConfig {
  url: string;
  agentName: string;
  facilitator: string | undefined;
}

export function configFromEnv(env: Record<string, string | undefined>): CliConfig {
  return {
    url: (env['TRELLIS_URL'] ?? 'http://localhost:8080').replace(/\/+$/, ''),
    agentName: env['TRELLIS_AGENT_NAME'] || 'Claude Code',
    facilitator: env['TRELLIS_FACILITATOR'] || undefined,
  };
}

export class Api {
  constructor(readonly url: string) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { 'content-type': 'application/json' };
    }
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, init);
    } catch {
      throw new CliError(EXIT.unreachable, `Can't reach the Trellis server at ${this.url}. Is it running? (set TRELLIS_URL to change)`);
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      throw new CliError(EXIT.unreachable, `${this.url}${path} did not return JSON (is TRELLIS_URL pointing at Trellis?)`);
    }
    if (!res.ok) {
      const err = data as Partial<ApiError> | null;
      const code = err?.error ?? `HTTP_${res.status}`;
      const exit = code === 'FROZEN' ? EXIT.frozen : res.status === 400 ? EXIT.usage : EXIT.rejected;
      throw new CliError(exit, `${code}: ${err?.message ?? res.statusText}`, err?.details);
    }
    return data as T;
  }

  status(): Promise<Status> { return this.call('GET', '/api/status'); }
  state(): Promise<RoadmapState> { return this.call('GET', '/api/state'); }
  epic(id: string): Promise<{ epic: Epic; tickets: Ticket[] }> { return this.call('GET', `/api/epics/${encodeURIComponent(id)}`); }
  ticket(id: string): Promise<{ ticket: Ticket }> { return this.call('GET', `/api/tickets/${encodeURIComponent(id)}`); }
  batch(batch: Batch): Promise<BatchResult> { return this.call('POST', '/api/batch', batch); }
  claim(ids: string[], holder: string, note?: string, ttlSec?: number): Promise<{ claims: Claim[] }> {
    return this.call('POST', '/api/claims', { ids, holder, ...(note !== undefined ? { note } : {}), ...(ttlSec !== undefined ? { ttlSec } : {}) });
  }
  release(ids: string[], holder: string): Promise<{ claims: Claim[] }> { return this.call('DELETE', '/api/claims', { ids, holder }); }
  undo(batchId: string, author: Author): Promise<BatchResult> { return this.call('POST', '/api/undo', { batchId, author }); }
  changeset(): Promise<Changeset> { return this.call('GET', '/api/changeset'); }
  freeze(by: string): Promise<{ changeset: Changeset }> { return this.call('POST', '/api/freeze', { by }); }
  unfreeze(): Promise<{ frozen: null }> { return this.call('POST', '/api/unfreeze'); }
}
