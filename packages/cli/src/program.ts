// The `trellis` command (PLAN.md §8). `run()` never calls process.exit: it returns the exit code,
// so tests can drive it with fake stdin/stdout.
import { Command, CommanderError, Option } from 'commander';
import type { Author, Batch, Milestone, Op, RoadmapState, ScopeSummary, ServerMessage } from '@trellis/shared';
import { scopeSummary, scopeWarnings } from '@trellis/shared';
import {
  parseDate, parseList, parseNumberOrNone, parseOpsInput, parseShift, parseTtl, resolvePerson, shiftDate,
} from './args.js';
import { Api, configFromEnv } from './client.js';
import type { CliConfig } from './client.js';
import { CliError, EXIT, exitForBatch } from './errors.js';
import type { ExitCode } from './errors.js';
import * as fmt from './format.js';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  readStdin: () => Promise<string>;
  env: Record<string, string | undefined>;
  /** Resolves when the user interrupts `watch` (Ctrl-C). */
  interrupted?: Promise<void>;
}

const fail = (exitCode: ExitCode, message: string): never => {
  throw new CliError(exitCode, message);
};

interface WriteOpts {
  reason?: string;
  askedBy?: string;
  base?: string;
  nonAtomic?: boolean;
}

export async function run(argv: string[], io: Io): Promise<ExitCode> {
  let code: ExitCode = EXIT.ok;
  const cfg: CliConfig = configFromEnv(io.env);
  const program = new Command('trellis');
  // Set by the preAction hook; an object so TS doesn't narrow it to its initial value.
  const flags = { json: false };
  let api = new Api(cfg.url);
  const author: Author = { name: cfg.agentName, kind: 'agent' };

  const print = (data: unknown, human: () => string): void => {
    io.out(flags.json ? JSON.stringify(data, null, 2) : human());
  };

  /** Send ops as one batch with the shared write flags; prints the result and sets the exit code. */
  async function write(ops: Op[], opts: WriteOpts, extra: Partial<Batch> = {}): Promise<void> {
    const batch: Batch = { author, ops, atomic: !opts.nonAtomic, ...extra };
    const reason = opts.reason ?? extra.reason;
    const askedBy = opts.askedBy ?? extra.askedBy ?? cfg.facilitator;
    if (reason !== undefined) batch.reason = reason;
    if (askedBy !== undefined) batch.askedBy = askedBy;
    if (opts.base !== undefined) {
      const n = Number(opts.base);
      if (!Number.isInteger(n) || n < 0) throw new CliError(EXIT.usage, `--base must be a version number, got "${opts.base}"`);
      batch.baseVersion = n;
    }
    const result = await api.batch(batch);
    print(result, () => fmt.batchResult(result));
    code = exitForBatch(result);
  }

  const withWriteFlags = (cmd: Command): Command =>
    cmd
      .option('--reason <text>', 'the request in plain words (shown to everyone, kept for Jira)')
      .option('--asked-by <name>', 'who asked (default: $TRELLIS_FACILITATOR)')
      .option('--base <version>', 'state version you read; newer human edits are then kept')
      .option('--non-atomic', 'apply the valid ops even if some are rejected');

  const state = (): Promise<RoadmapState> => api.state();

  program
    .description('Read and edit the live Trellis roadmap. Every write is validated and shown live to everyone.')
    .option('--json', 'print JSON instead of text')
    .option('--url <url>', 'server URL (default: $TRELLIS_URL or http://localhost:8080)')
    .hook('preAction', (cmd) => {
      const g = cmd.optsWithGlobals<{ json?: boolean; url?: string }>();
      flags.json = g.json === true;
      if (g.url) api = new Api(g.url.replace(/\/+$/, ''));
    })
    .exitOverride()
    .configureOutput({ writeOut: (s) => { io.out(s.trimEnd()); }, writeErr: (s) => { io.err(s.trimEnd()); } })
    .showHelpAfterError();

  // --- reads

  program.command('status').description('version, frozen, people, claims and pending changes (exit 4 if frozen)').action(async () => {
    const [s, st] = await Promise.all([api.status(), state()]);
    print(s, () => fmt.status(s, st));
    if (s.frozen) code = EXIT.frozen;
  });

  program
    .command('get')
    .description('show an epic or ticket')
    .argument('<kindOrId>', 'epic | ticket | an id')
    .argument('[id]')
    .action(async (kindOrId: string, maybeId: string | undefined) => {
      const kind = maybeId ? kindOrId : null;
      const id = maybeId ?? kindOrId;
      const st = await state();
      if (kind === 'epic' || (kind === null && st.epics[id])) {
        const r = await api.epic(id);
        print(r, () => fmt.epic(r.epic, r.tickets));
      } else if (kind === 'ticket' || kind === null) {
        const r = await api.ticket(id);
        print(r, () => fmt.ticket(r.ticket, st));
      } else {
        throw new CliError(EXIT.usage, `expected "epic" or "ticket", got "${kind}"`);
      }
    });

  program
    .command('list')
    .description('list epics or tickets')
    .argument('<what>', 'epics | tickets')
    .option('--epic <id>', 'only tickets in this epic ("none" for tickets without one)')
    .option('--filter <text>', 'match key, summary, assignee, labels or status')
    .action(async (what: string, opts: { epic?: string; filter?: string }) => {
      const st = await state();
      if (what === 'epics') {
        const epics = st.epicOrder.flatMap((id) => (st.epics[id] ? [st.epics[id]] : []));
        print(epics, () => fmt.epicList(st));
        return;
      }
      if (what !== 'tickets') throw new CliError(EXIT.usage, `expected "epics" or "tickets", got "${what}"`);
      const q = opts.filter?.toLowerCase();
      const tickets = Object.values(st.tickets)
        .filter((t) => opts.epic === undefined || (opts.epic === 'none' ? t.epicId === null : t.epicId === opts.epic))
        .filter((t) => !q || [t.id, t.summary, t.status, t.assignee?.displayName ?? '', ...t.labels].some((s) => s.toLowerCase().includes(q)))
        .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
      print(tickets, () => fmt.ticketList(tickets));
    });

  program
    .command('snapshot-diff')
    .description('how the roadmap (or one item) differs from the Jira snapshot')
    .argument('[id]')
    .action(async (id: string | undefined) => {
      const cs = await api.changeset();
      const ops = id ? cs.ops.filter((o) => o.target === id || ('to' in o && o.to === id)) : cs.ops;
      print(id ? ops : cs, () => fmt.changeset(cs, id));
    });

  program.command('changeset').description('the changeset that freeze would write').action(async () => {
    const cs = await api.changeset();
    print(cs, () => fmt.changeset(cs));
  });

  // --- claims

  program
    .command('claim')
    .description('soft-lock items while you change them (others get LOCKED)')
    .argument('<ids...>')
    .option('--note <text>', 'what you are doing')
    .option('--ttl <duration>', 'how long, e.g. 30s, 5m, 1h', '5m')
    .action(async (ids: string[], opts: { note?: string; ttl: string }) => {
      const r = await api.claim(ids, author.name, opts.note, parseTtl(opts.ttl));
      print(r, () => `claimed ${ids.join(', ')} for ${opts.ttl}`);
    });

  program
    .command('release')
    .description('release your claims')
    .argument('<ids...>')
    .action(async (ids: string[]) => {
      const r = await api.release(ids, author.name);
      print(r, () => `released ${ids.join(', ')}`);
    });

  // --- epics

  const epic = program.command('epic').description('create or change epics');

  withWriteFlags(epic.command('create').description('add a new epic (gets a NEW-n id)'))
    .requiredOption('--summary <text>')
    .option('--description <text>')
    .option('--start <date>', 'YYYY-MM-DD')
    .option('--due <date>', 'YYYY-MM-DD')
    .option('--status <name>')
    .option('--temp-id <NEW-n>', 'choose the temp id (to refer to it later in the same session)')
    .action(async (o: WriteOpts & { summary: string; description?: string; start?: string; due?: string; status?: string; tempId?: string }) => {
      const fields: Extract<Op, { type: 'epic.create' }>['fields'] = { summary: o.summary };
      if (o.description !== undefined) fields.description = o.description;
      if (o.start !== undefined) fields.startDate = parseDate(o.start, '--start');
      if (o.due !== undefined) fields.dueDate = parseDate(o.due, '--due');
      if (o.status !== undefined) fields.status = o.status;
      await write([{ type: 'epic.create', fields, ...(o.tempId ? { tempId: o.tempId } : {}) }], o);
    });

  withWriteFlags(epic.command('update').description('change summary, description or colour').argument('<id>'))
    .option('--summary <text>')
    .option('--description <text>', '"" clears it')
    .option('--color <token>')
    .action(async (id: string, o: WriteOpts & { summary?: string; description?: string; color?: string }) => {
      const fields: Extract<Op, { type: 'epic.update' }>['fields'] = {};
      if (o.summary !== undefined) fields.summary = o.summary;
      if (o.description !== undefined) fields.description = o.description;
      if (o.color !== undefined) fields.color = o.color;
      if (Object.keys(fields).length === 0) throw new CliError(EXIT.usage, 'nothing to update: pass --summary, --description or --color');
      await write([{ type: 'epic.update', id, fields }], o);
    });

  withWriteFlags(epic.command('dates').description('set or shift start and due dates').argument('<id>'))
    .option('--start <date>', 'YYYY-MM-DD or "none"')
    .option('--due <date>', 'YYYY-MM-DD or "none"')
    .option('--shift <amount>', 'move both dates, e.g. 1m, -2w, 1q (month ends stay month ends)')
    .action(async (id: string, o: WriteOpts & { start?: string; due?: string; shift?: string }) => {
      const { epic: e } = await api.epic(id);
      let startDate = o.start !== undefined ? parseDate(o.start, '--start') : e.startDate;
      let dueDate = o.due !== undefined ? parseDate(o.due, '--due') : e.dueDate;
      if (o.shift !== undefined) {
        const s = parseShift(o.shift);
        if (!startDate && !dueDate) throw new CliError(EXIT.usage, `${id} has no dates to shift; set them with --start/--due`);
        startDate = startDate ? shiftDate(startDate, s) : null;
        dueDate = dueDate ? shiftDate(dueDate, s) : null;
      } else if (o.start === undefined && o.due === undefined) {
        throw new CliError(EXIT.usage, 'pass --start, --due or --shift');
      }
      await write([{ type: 'epic.setDates', id, startDate, dueDate }], o);
    });

  withWriteFlags(epic.command('transition').description('change status').argument('<id>').argument('<status>')).action(
    async (id: string, status: string, o: WriteOpts) => { await write([{ type: 'epic.transition', id, status }], o); },
  );

  withWriteFlags(epic.command('reorder').description('move an epic to a position in the list').argument('<id>').argument('<index>')).action(
    async (id: string, index: string, o: WriteOpts) => {
      const n = Number(index);
      if (!Number.isInteger(n) || n < 0) throw new CliError(EXIT.usage, `index must be 0 or more, got "${index}"`);
      await write([{ type: 'epic.reorder', id, index: n }], o);
    },
  );

  withWriteFlags(epic.command('defer').description('move to Deliver later (clears its dates; its tickets keep their own flags)').argument('<id>')).action(
    async (id: string, o: WriteOpts) => { await write([{ type: 'epic.defer', id, deferred: true }], o); },
  );

  withWriteFlags(epic.command('undefer').description('take out of Deliver later, optionally with new dates').argument('<id>'))
    .option('--start <date>', 'YYYY-MM-DD')
    .option('--due <date>', 'YYYY-MM-DD')
    .action(async (id: string, o: WriteOpts & { start?: string; due?: string }) => {
      const ops: Op[] = [{ type: 'epic.defer', id, deferred: false }];
      if (o.start !== undefined || o.due !== undefined) {
        const startDate = o.start !== undefined ? parseDate(o.start, '--start') : null;
        const dueDate = o.due !== undefined ? parseDate(o.due, '--due') : null;
        ops.push({ type: 'epic.setDates', id, startDate, dueDate });
      }
      await write(ops, o);
    });

  // --- tickets

  const ticket = program.command('ticket').description('create or change tickets');

  withWriteFlags(ticket.command('create').description('add a new ticket (gets a NEW-n id)'))
    .requiredOption('--summary <text>')
    .option('--epic <id>', 'parent epic, or "none"', 'none')
    .addOption(new Option('--type <name>', 'issue type, e.g. Story, Task, Bug'))
    .option('--description <text>')
    .option('--assignee <who>', 'account id or name')
    .option('--labels <a,b>')
    .option('--points <n>')
    .option('--status <name>')
    .option('--temp-id <NEW-n>')
    .action(async (o: WriteOpts & { summary: string; epic: string; type?: string; description?: string; assignee?: string; labels?: string; points?: string; status?: string; tempId?: string }) => {
      const fields: Extract<Op, { type: 'ticket.create' }>['fields'] = { summary: o.summary };
      if (o.type !== undefined) fields.issueType = o.type;
      if (o.description !== undefined) fields.description = o.description;
      if (o.assignee !== undefined) fields.assignee = resolvePerson(o.assignee, await state());
      if (o.labels !== undefined) fields.labels = parseList(o.labels);
      if (o.points !== undefined) fields.storyPoints = parseNumberOrNone(o.points, '--points');
      if (o.status !== undefined) fields.status = o.status;
      await write([{ type: 'ticket.create', epicId: o.epic === 'none' ? null : o.epic, fields, ...(o.tempId ? { tempId: o.tempId } : {}) }], o);
    });

  withWriteFlags(ticket.command('update').description('change ticket fields').argument('<id>'))
    .option('--summary <text>')
    .option('--description <text>', '"" clears it')
    .option('--assignee <who>', 'account id, name, or "none"')
    .option('--labels <a,b>', 'replace all labels ("" for none)')
    .option('--add-label <label>')
    .option('--remove-label <label>')
    .option('--points <n>', 'story points, or "none"')
    .option('--type <name>')
    .action(async (id: string, o: WriteOpts & { summary?: string; description?: string; assignee?: string; labels?: string; addLabel?: string; removeLabel?: string; points?: string; type?: string }) => {
      const fields: Extract<Op, { type: 'ticket.update' }>['fields'] = {};
      if (o.summary !== undefined) fields.summary = o.summary;
      if (o.description !== undefined) fields.description = o.description;
      if (o.type !== undefined) fields.issueType = o.type;
      if (o.points !== undefined) fields.storyPoints = parseNumberOrNone(o.points, '--points');
      if (o.assignee !== undefined || o.addLabel !== undefined || o.removeLabel !== undefined) {
        const st = await state();
        if (o.assignee !== undefined) fields.assignee = resolvePerson(o.assignee, st);
        if (o.addLabel !== undefined || o.removeLabel !== undefined) {
          const t = st.tickets[id];
          if (!t) throw new CliError(EXIT.rejected, `ticket ${id} not found`);
          const set = new Set(o.labels !== undefined ? parseList(o.labels) : t.labels);
          if (o.addLabel !== undefined) set.add(o.addLabel);
          if (o.removeLabel !== undefined) set.delete(o.removeLabel);
          fields.labels = [...set];
        }
      }
      if (o.labels !== undefined && fields.labels === undefined) fields.labels = parseList(o.labels);
      if (Object.keys(fields).length === 0) throw new CliError(EXIT.usage, 'nothing to update');
      await write([{ type: 'ticket.update', id, fields }], o);
    });

  withWriteFlags(ticket.command('move').description('move to another epic and/or position').argument('<id>'))
    .requiredOption('--epic <id>', 'target epic, or "none"')
    .option('--index <n>', 'position within the epic (default: last)')
    .action(async (id: string, o: WriteOpts & { epic: string; index?: string }) => {
      const op: Extract<Op, { type: 'ticket.move' }> = { type: 'ticket.move', id, epicId: o.epic === 'none' ? null : o.epic };
      if (o.index !== undefined) {
        const n = Number(o.index);
        if (!Number.isInteger(n) || n < 0) throw new CliError(EXIT.usage, `--index must be 0 or more, got "${o.index}"`);
        op.index = n;
      }
      await write([op], o);
    });

  withWriteFlags(ticket.command('transition').description('change status').argument('<id>').argument('<status>')).action(
    async (id: string, status: string, o: WriteOpts) => { await write([{ type: 'ticket.transition', id, status }], o); },
  );

  withWriteFlags(ticket.command('discard').description('remove a NEW-* ticket that only exists in Trellis').argument('<id>')).action(
    async (id: string, o: WriteOpts) => { await write([{ type: 'ticket.discardNew', id }], o); },
  );

  withWriteFlags(ticket.command('defer').description('move this ticket alone to Deliver later (its epic stays scheduled)').argument('<id>')).action(
    async (id: string, o: WriteOpts) => { await write([{ type: 'ticket.defer', id, deferred: true }], o); },
  );

  withWriteFlags(ticket.command('undefer').description('take this ticket out of Deliver later').argument('<id>')).action(
    async (id: string, o: WriteOpts) => { await write([{ type: 'ticket.defer', id, deferred: false }], o); },
  );

  // --- milestones and scope

  const milestone = program.command('milestone').description('delivery dates on the timeline (Trellis only, not in Jira)');

  milestone.command('list').description('milestones by date').action(async () => {
    const st = await state();
    print(st.timeline.milestones, () => fmt.milestones(st));
  });

  /** Change the milestone list as one timeline.set; --base defaults to the version just read. */
  async function editMilestones(o: WriteOpts, edit: (list: Milestone[], st: RoadmapState) => Milestone[]): Promise<void> {
    const st = await state();
    const timeline = { ...st.timeline, milestones: edit(st.timeline.milestones.map((m) => ({ ...m })), st) };
    await write([{ type: 'timeline.set', timeline }], { ...o, base: o.base ?? String(st.version) });
  }
  const findIn = (list: Milestone[], id: string): Milestone =>
    list.find((m) => m.id === id) ?? fail(EXIT.rejected, `no milestone ${id} (known: ${list.map((m) => m.id).join(', ') || 'none'})`);
  const requireDate = (value: string, what: string): string => parseDate(value, what) ?? fail(EXIT.usage, `${what} must be a date, not "none"`);

  withWriteFlags(milestone.command('add').description('add a milestone, e.g. trellis milestone add Delivery 2026-11-09').argument('<label>').argument('<date>'))
    .option('--id <id>', 'choose the id (default: next m<n>)')
    .action(async (label: string, date: string, o: WriteOpts & { id?: string }) => {
      const d = requireDate(date, '<date>');
      await editMilestones(o, (list) => {
        const used = new Set(list.map((m) => m.id));
        if (o.id !== undefined && used.has(o.id)) fail(EXIT.rejected, `milestone ${o.id} already exists`);
        let n = 1;
        while (used.has(`m${n}`)) n++;
        return [...list, { id: o.id ?? `m${n}`, label, date: d }];
      });
    });

  withWriteFlags(milestone.command('set').description('move a milestone to a new date').argument('<id>').argument('<date>'))
    .option('--label <text>', 'rename it too')
    .action(async (id: string, date: string, o: WriteOpts & { label?: string }) => {
      const d = requireDate(date, '<date>');
      await editMilestones(o, (list) => {
        const m = findIn(list, id);
        m.date = d;
        if (o.label !== undefined) m.label = o.label;
        return list;
      });
    });

  withWriteFlags(milestone.command('remove').description('remove a milestone').argument('<id>')).action(async (id: string, o: WriteOpts) => {
    await editMilestones(o, (list) => {
      findIn(list, id);
      return list.filter((m) => m.id !== id);
    });
  });

  program
    .command('scope')
    .description('what makes a milestone, what is in Deliver later, and warnings')
    .option('--milestone <id>', 'count against this milestone (default: the first)')
    .action(async (o: { milestone?: string }) => {
      const st = await state();
      let summary: ScopeSummary;
      try {
        summary = scopeSummary(st, o.milestone);
      } catch (err) {
        throw new CliError(EXIT.rejected, (err as Error).message);
      }
      const warnings = scopeWarnings(st, new Date().toISOString().slice(0, 10));
      print({ ...summary, warnings }, () => fmt.scope(summary, warnings, st));
    });

  // --- links

  withWriteFlags(
    program
      .command('link')
      .description('add or remove a "blocks" dependency: trellis link add PROJ-1 blocks PROJ-2')
      .argument('<add|remove>')
      .argument('<from>')
      .argument('<blocks>')
      .argument('<to>'),
  ).action(async (action: string, from: string, rel: string, to: string, o: WriteOpts) => {
    if (rel !== 'blocks') throw new CliError(EXIT.usage, `only "blocks" links can be edited, got "${rel}"`);
    if (action !== 'add' && action !== 'remove') throw new CliError(EXIT.usage, `expected add or remove, got "${action}"`);
    await write([{ type: action === 'add' ? 'link.add' : 'link.remove', from, to, linkType: 'blocks' }], o);
  });

  // --- batches

  withWriteFlags(program.command('batch').description('send ops from stdin as one batch (JSON array or {"ops": [...]})')).action(async (o: WriteOpts) => {
    const { ops, batch } = parseOpsInput(await io.readStdin());
    const extra: Partial<Batch> = {};
    if (batch.reason !== undefined) extra.reason = batch.reason;
    if (batch.askedBy !== undefined) extra.askedBy = batch.askedBy;
    const opts: WriteOpts = { ...o };
    if (o.base === undefined && batch.baseVersion !== undefined) opts.base = String(batch.baseVersion);
    if (!o.nonAtomic && batch.atomic === false) opts.nonAtomic = true;
    await write(ops, opts, extra);
  });

  program
    .command('undo')
    .description('undo a batch (refused if later batches changed the same fields)')
    .argument('<batchId>')
    .action(async (batchId: string) => {
      const r = await api.undo(batchId, author);
      print(r, () => fmt.batchResult(r));
      code = exitForBatch(r);
    });

  // --- freeze

  program
    .command('freeze')
    .description('lock editing and write the changeset for apply')
    .option('--by <name>', 'who froze it (default: $TRELLIS_FACILITATOR or the agent name)')
    .action(async (o: { by?: string }) => {
      const r = await api.freeze(o.by ?? cfg.facilitator ?? author.name);
      print(r, () => `frozen · ${fmt.changeset(r.changeset)}`);
    });

  program.command('unfreeze').description('reopen editing').action(async () => {
    const r = await api.unfreeze();
    print(r, () => 'unfrozen');
  });

  // --- watch

  program
    .command('watch')
    .description('stream batches, presence and freeze events (shows you as an agent while running)')
    .option('--limit <n>', 'exit after n changes: batches, freeze, reload (1 = wait for the next change)')
    .action(async (o: { limit?: string }) => {
      const limit = o.limit !== undefined ? Number(o.limit) : Infinity;
      if (!(limit > 0)) throw new CliError(EXIT.usage, `--limit must be a positive number, got "${o.limit ?? ''}"`);
      await watch(api.url, author.name, limit, io, flags.json);
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode === 0 ? EXIT.ok : EXIT.usage;
    }
    if (err instanceof CliError) {
      if (flags.json) io.out(JSON.stringify({ error: err.message, details: err.details ?? null }, null, 2));
      else io.err(`trellis: ${err.message}`);
      return err.exitCode;
    }
    throw err;
  }
  return code;
}

const CHANGE_EVENTS = new Set<ServerMessage['type']>(['batch.applied', 'freeze', 'snapshot.reloaded']);

async function watch(url: string, name: string, limit: number, io: Io, json: boolean): Promise<void> {
  const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/ws`);
  let seen = 0;
  await new Promise<void>((resolve, reject) => {
    ws.onerror = () => { reject(new CliError(EXIT.unreachable, `Can't reach the Trellis server at ${url}`)); };
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'hello', name, kind: 'agent', clientId: `cli-${name}-${process.pid}-${Math.random().toString(36).slice(2, 8)}` })); };
    ws.onclose = () => { resolve(); };
    ws.onmessage = (ev: { data: unknown }) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : '{}') as ServerMessage;
      if (m.type === 'welcome') {
        if (!json) io.err(`watching ${url} as ${name} (v${m.version}); Ctrl-C to stop`);
        return;
      }
      if (seen >= limit) return; // closing: ignore anything that arrives meanwhile
      const line = json ? JSON.stringify(m) : fmt.watchEvent(m);
      if (line === null) return;
      io.out(line);
      // --limit counts changes to the roadmap, not presence/claims chatter.
      if (CHANGE_EVENTS.has(m.type) && ++seen >= limit) ws.close();
    };
    void io.interrupted?.then(() => { ws.close(); });
  });
}
