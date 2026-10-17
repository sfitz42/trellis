// HTTP API (PLAN.md §5), used by the CLI and handy for debugging with curl.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Author, Batch, IssueId } from '@trellis/shared';
import type { ApiError } from '@trellis/shared';
import { SessionError } from './session.js';
import type { Session } from './session.js';

const ClaimBody = z.strictObject({ ids: z.array(IssueId).min(1), holder: z.string().min(1), note: z.string().optional(), ttlSec: z.number().positive().optional() });
const ReleaseBody = z.strictObject({ ids: z.array(IssueId).min(1), holder: z.string().min(1) });
const UndoBody = z.strictObject({ batchId: z.string().min(1), author: Author });
const FreezeBody = z.strictObject({ by: z.string().min(1) });

function bad(reply: FastifyReply, status: number, error: string, message: string, details?: unknown): FastifyReply {
  const body: ApiError = { error, message };
  if (details !== undefined) body.details = details;
  return reply.code(status).send(body);
}

function parse<T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | undefined {
  const r = schema.safeParse(body ?? {});
  if (r.success) return r.data;
  void bad(reply, 400, 'INVALID_REQUEST', z.prettifyError(r.error), r.error.issues);
  return undefined;
}

export function registerHttp(app: FastifyInstance, session: Session): void {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof SessionError) return bad(reply, err.status, err.code, err.message, err.details);
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode !== undefined && e.statusCode < 500) return bad(reply, e.statusCode, e.code ?? 'BAD_REQUEST', e.message);
    app.log.error(err);
    return bad(reply, 500, 'INTERNAL', e.message);
  });

  app.get('/api/status', () => session.status());
  app.get('/api/state', () => session.getState());

  app.get<{ Params: { id: string } }>('/api/epics/:id', (req, reply) => {
    const state = session.getState();
    const epic = state.epics[req.params.id];
    if (!epic) return bad(reply, 404, 'NOT_FOUND', `epic ${req.params.id} not found`);
    return { epic, tickets: epic.ticketOrder.flatMap((id) => (state.tickets[id] ? [state.tickets[id]] : [])) };
  });

  app.get<{ Params: { id: string } }>('/api/tickets/:id', (req, reply) => {
    const ticket = session.getState().tickets[req.params.id];
    if (!ticket) return bad(reply, 404, 'NOT_FOUND', `ticket ${req.params.id} not found`);
    return { ticket };
  });

  // Always 200 once the batch is well-formed: per-op outcomes (including FROZEN) are in the body.
  app.post('/api/batch', (req, reply) => {
    const batch = parse(Batch, req.body, reply);
    if (!batch) return reply;
    return session.submit(batch);
  });

  app.post('/api/claims', (req, reply) => {
    const body = parse(ClaimBody, req.body, reply);
    if (!body) return reply;
    const by: Parameters<Session['claim']>[1] = { holder: body.holder };
    if (body.note !== undefined) by.note = body.note;
    if (body.ttlSec !== undefined) by.ttlSec = body.ttlSec;
    const res = session.claim(body.ids, by);
    if (!res.ok) return bad(reply, 409, 'LOCKED', `already claimed: ${res.conflicts.map((c) => `${c.id} by ${c.holder}`).join(', ')}`, res.conflicts);
    return { claims: res.claims };
  });

  app.delete('/api/claims', (req, reply) => {
    const body = parse(ReleaseBody, req.body, reply);
    if (!body) return reply;
    return { claims: session.release(body.ids, { holder: body.holder }) };
  });

  app.post('/api/undo', (req, reply) => {
    const body = parse(UndoBody, req.body, reply);
    if (!body) return reply;
    const { plan, result } = session.undo(body.batchId, body.author);
    if (!plan.ok) {
      const status = plan.reason === 'NOT_FOUND' ? 404 : 409;
      const msg = plan.reason === 'CONFLICT'
        ? `later batches changed the same fields: ${plan.conflicts.map((c) => `${c.key} (${c.batchId})`).join(', ')}`
        : plan.reason === 'NOT_FOUND' ? `batch ${body.batchId} not found` : `batch ${body.batchId} applied nothing`;
      return bad(reply, status, `UNDO_${plan.reason}`, msg, plan.conflicts);
    }
    return result;
  });

  app.get('/api/changeset', () => session.changeset());

  app.post('/api/freeze', async (req, reply) => {
    const body = parse(FreezeBody, req.body, reply);
    if (!body) return reply;
    return { changeset: await session.freeze(body.by) };
  });

  app.post('/api/unfreeze', async () => {
    await session.unfreeze();
    return { frozen: null };
  });

  app.post('/api/snapshot/reload', () => session.reloadSnapshot());
}
