# Trellis — Build Plan

_Epics are the frame, tickets grow along it._

A small, local-first web app for building a delivery roadmap together, live, on top of a Jira project.
Epics are bars on a timeline, tickets sit under them, and a group edits the plan in real time. The
facilitator's coding agent (Claude Code or GitHub Copilot) joins the session through a CLI so spoken
or typed requests become live edits. When the group agrees, the session is frozen, a changeset is
generated, and the agent applies it to Jira through the Atlassian CLI.

**The app contains no AI.** All intelligence lives in the facilitator's agent. The app is a
real-time editor, a CLI, and a pair of Jira scripts.

### Related documents

| Document | Where | What it's for |
|---|---|---|
| **Project brief** | [Trellis — Project Brief](https://claude.ai/code/artifact/faa633ff-b2bb-4ca5-a758-2ea2bda6e3fe) (live doc) · exported to `docs/brief.md` | The why: problem, session flow, key decisions with reasoning, visual language, open questions. Read it before this plan. |
| **Design screens** | [Trellis Screens canvas](https://claude.ai/artifact/Tc86u1GSQqM1Y6pPLUTWuz) · exported to `docs/design/*.png` | The visual reference for §9. |
| **This plan** | `docs/PLAN.md` | The how: architecture, schemas, protocol, phases. |

The links are for people; they are private until shared. Agents can't open them, so they work
from the exported copies in `docs/`. If the brief and this plan disagree, **this plan wins** for
implementation details, and the brief wins on intent. Flag any conflict to the facilitator rather
than picking silently. When a decision changes, update both.

---

## 1. Goals and non-goals

### Goals
- Visual roadmap: epics as bars on a configurable time axis (months by default; quarters, weeks or
  custom ranges). **Not tied to sprints.**
- Real-time collaboration for a handful of people on a LAN, via websockets.
- The facilitator's agent can read and edit the live roadmap through a CLI, and every agent batch
  records the natural-language request that caused it.
- Create, move and edit tickets and epics: summary, description, assignee, labels, story points,
  status transitions, dependencies (blocks / is blocked by), epic start and due dates.
- Clear separation of: what Jira says (snapshot), what we want (roadmap), and what will change
  (changeset).
- Safe, reviewable, idempotent apply to Jira with drift detection.
- One pnpm monorepo. Runs with `pnpm dev` locally, with `docker compose up` on a laptop or LAN
  box, or from the same Dockerfile on any container host.

### Non-goals (v1)
- No built-in LLM, chat, or request queue in the app.
- No authentication (LAN only; display-name prompt for presence).
- No multi-project or multi-room support. One server = one roadmap session.
- No horizontal scaling. One server process holds the authoritative state.
- No deleting Jira issues, ever. Removing an existing ticket = transition to a closed status.
- Direct editing of `roadmap.json` by agents is **not** supported in v1 (it is a read-only mirror;
  agents write through the CLI). Keep the design open to adding a file-watch path later.

---

## 2. Architecture

```
┌──────────────┐  ws (ops, presence)  ┌───────────────────────────┐
│ Browser SPA  │◀────────────────────▶│                           │
│ (Svelte 5)   │                      │   Server (Node, Fastify)  │
└──────────────┘                      │   - authoritative state   │
┌──────────────┐  http (batch, get)   │   - op validation/reducer │
│ trellis CLI  │─────────────────────▶│   - version + op log      │
│ (agent)      │◀───── ws (watch) ────│   - presence, soft locks  │
└──────────────┘                      │   - freeze + changeset    │
                                      └────────────┬──────────────┘
                                                   │ reads/writes
                                      ┌────────────▼──────────────┐
                                      │ ./workspace/ (volume)     │
                                      │ snapshot.json  (Jira now) │
                                      │ roadmap.json   (mirror)   │
                                      │ changeset.json (derived)  │
                                      │ oplog.jsonl, apply-log…   │
                                      └────────────▲──────────────┘
                                                   │ pull / apply (facilitator's machine)
                                      ┌────────────┴──────────────┐
                                      │ packages/jira → acli      │──▶ Jira Cloud
                                      └───────────────────────────┘
```

### Monorepo layout (pnpm workspaces, TypeScript everywhere)

Everything lives in one repository and one pnpm workspace. Each app and package has its own
`package.json` (scoped `@trellis/*`, `"private": true`, `"type": "module"`), its own `tsconfig.json`
extending the base, and depends on siblings with `workspace:*`. No Turborepo/Nx in v1: the root
scripts use `pnpm -r` and `--filter`, and `tsc -b` follows project references for build order.

```
/
├─ package.json                 # root scripts only, "packageManager": "pnpm@<pinned>"
├─ pnpm-workspace.yaml          # apps/*, packages/*
├─ pnpm-lock.yaml               # committed
├─ .npmrc                       # ignore-scripts=true (see below)
├─ tsconfig.base.json           # strict settings shared by every package
├─ tsconfig.json                # solution file: references every package for `tsc -b`
├─ apps/
│  ├─ server/   @trellis/server # Fastify + ws, persistence, freeze, file mirror
│  └─ web/      @trellis/web    # Svelte 5 + Vite SPA (built assets served by the server)
├─ packages/
│  ├─ shared/   @trellis/shared # types, zod schemas, reducer, diff, changeset — no I/O
│  ├─ cli/      @trellis/cli    # `trellis` command (bin)
│  └─ jira/     @trellis/jira   # pull, apply, acli adapter, env loader
├─ workspace/                   # runtime data (gitignored except README/AGENTS.md)
├─ docs/
│  ├─ PLAN.md                   # this plan
│  ├─ brief.md                  # project brief, exported from the live doc
│  ├─ jira-mapping.md           # produced in Phase 0
│  └─ design/                   # exported screen images from the design canvas
├─ .env.example                 # JIRA_SITE, JIRA_PROJECT_KEY, PORT…
├─ .claude/skills/trellis/SKILL.md   # how agents use the CLI
├─ AGENTS.md                    # same content for Copilot / other agents
├─ Dockerfile                   # builds the whole monorepo, ships only the server + web
├─ compose.yaml                 # local / LAN run (see §11)
└─ .dockerignore                # node_modules, workspace/, .env, dist, .git
```

Dependency direction is one-way: `shared` ← `server`, `web`, `cli`, `jira`. The web app never
imports server code; the CLI and jira packages never import server or web code.

### Tech choices
- **Node 22**, **pnpm** (pinned via the `packageManager` field and Corepack), `vitest` for tests,
  `tsx` for running TypeScript scripts in development.
- **TypeScript only.** No `.js`/`.mjs` source files anywhere (config files included, e.g.
  `vite.config.ts`, `svelte.config.ts` where supported). `tsconfig.base.json` sets `strict: true`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
  `verbatimModuleSyntax`, `module`/`moduleResolution: "NodeNext"` (bundler resolution for the web
  app). Packages use project references; `pnpm typecheck` runs `tsc -b` plus `svelte-check`, and it
  must pass with zero errors at the end of every phase. The web app is outside the `tsc -b` solution
  (tsc can't follow `.svelte` imports); `svelte-check` checks all of it, `.ts` included. Svelte components use `<script lang="ts">`.
  No `any` without a comment explaining why.
- **Install scripts disabled.** `.npmrc` contains `ignore-scripts=true`, so no dependency's
  `preinstall`/`install`/`postinstall` runs. Consequences to design for:
  - Don't rely on `pre*`/`post*` or `prepare` hooks in our own `package.json` either; every build
    step is an explicit script (`pnpm build`, `pnpm -r build`).
  - Prefer dependencies that work without install scripts (pure JS, or prebuilt binaries shipped as
    optional platform packages, like esbuild/Rollup used by Vite). Avoid native modules that compile
    on install.
  - If a dependency genuinely needs its install script, stop and ask. Don't remove the setting;
    the facilitator decides whether to allow that one package (e.g. via `onlyBuiltDependencies`).
  - CI and Docker install with `pnpm install --frozen-lockfile --ignore-scripts`.
- **Server:** Fastify, `@fastify/websocket` (or `ws`), `@fastify/static` to serve the built SPA.
- **Web:** Svelte 5 (runes), Vite, plain CSS with custom properties (tokens in §10). No component
  library. IBM Plex loads from Google Fonts with system fallbacks (offline LANs fall back cleanly).
  Logic lives in plain `.ts` modules with unit tests; every screen also has a server-side render
  test (`svelte/server`) against the fixture. Visual checks use the facilitator's Playwright MCP. Drag and drop with pointer events (or `svelte-dnd-action` if it fits cleanly).
- **Validation:** `zod` schemas in `packages/shared`, used by server, CLI and scripts.
- **CLI:** `commander` (or `citty`), compiled to a bin named `trellis`.

---

## 3. Data model (`packages/shared`)

All dates are ISO `YYYY-MM-DD`. IDs are Jira keys (`PROJ-123`) or temp IDs (`NEW-1`, `NEW-2`…)
for items created in the app and not yet in Jira. Temp IDs are allocated by the server.

```ts
type IssueId = string;               // "PROJ-123" | "NEW-7"

interface Person { accountId: string; displayName: string }

// Any Jira link type is kept and shown; v1 ops only add/remove 'Blocks'. A link may be stored on
// either issue (Jira returns both sides); diff and validation treat both copies as one link.
interface Link {
  type: string;                      // Jira link type name, e.g. 'Blocks', 'Relates'
  direction: 'outward' | 'inward';   // outward: "this <type> target"; inward: "target <type> this"
  target: IssueId;
  jiraLinkId?: string;               // needed to delete the link in Jira
}

interface Epic {
  id: IssueId;
  summary: string;
  description?: string;
  status: string;                    // Jira status name
  startDate: string | null;          // Trellis-owned: not read from or written to Jira (docs/jira-mapping.md)
  dueDate: string | null;            // set in Jira on create; afterwards Trellis-owned (changes go to Jira as comments)
  ticketOrder: IssueId[];            // display order of child tickets
  color?: string;                    // optional token name for the bar
}

interface Ticket {
  id: IssueId;
  epicId: IssueId | null;            // parent epic
  issueType: string;                 // Story, Task, Bug…
  summary: string;
  description?: string;              // plain text / markdown in v1 (see ADF note in §7)
  status: string;
  assignee: Person | null;
  labels: string[];
  storyPoints: number | null;        // Trellis-owned, like Epic.startDate
  links: Link[];
}

interface RoadmapState {
  project: { key: string; name: string };
  epics: Record<IssueId, Epic>;
  tickets: Record<IssueId, Ticket>;
  epicOrder: IssueId[];
  timeline: TimelineConfig;
  // per-field bookkeeping for conflict detection (not written to Jira)
  meta: Record<string /* `${id}.${field}` */, { version: number; author: string }>;
  version: number;                   // increments once per accepted batch
  frozen: null | { by: string; at: string };
}

interface TimelineConfig {
  scale: 'weeks' | 'months' | 'quarters' | 'custom';
  start: string;                     // first visible date
  end: string;                       // last visible date
  customRanges?: { label: string; start: string; end: string }[];
}
```

- `snapshot.json` = `{ pulledAt, project, epics, tickets, workflow }` — what Jira says. Written only
  by `packages/jira/pull.ts`. `workflow` = `{ epicIssueType, statuses, transitions, assignableUsers }`:
  the epic type name (hierarchy level 1), known statuses per issue type with their category,
  transitions per type (`null` when Jira can't tell us, as with `acli`; then any known status is
  allowed), and the people seen on issues, so the UI can offer valid choices.
- `roadmap.json` = `RoadmapState` without `meta`, pretty-printed with **stable key order** (sorted
  keys, epics/tickets sorted by id). Written by the server only, debounced (~500 ms) after changes.
- Timeline columns are **display only**. Epics store real dates; changing the scale never changes
  data. Dragging snaps to the current scale unit (month boundaries in month view, etc.).

---

## 4. Operations

Every edit — from a browser or the CLI — is an op inside a batch. One schema, one reducer.

```ts
type Op =
  | { type: 'epic.create';     tempId?: IssueId; fields: Partial<Epic> & { summary: string } }
  | { type: 'epic.update';     id: IssueId; fields: Partial<Pick<Epic,'summary'|'description'|'color'>> }
  | { type: 'epic.setDates';   id: IssueId; startDate: string | null; dueDate: string | null }
  | { type: 'epic.transition'; id: IssueId; status: string }
  | { type: 'epic.reorder';    id: IssueId; index: number }
  | { type: 'epic.discardNew'; id: IssueId }          // only for empty NEW-* epics (makes epic.create undoable)
  | { type: 'ticket.create';   tempId?: IssueId; epicId: IssueId | null; fields: Partial<Ticket> & { summary: string } }
  | { type: 'ticket.update';   id: IssueId; fields: Partial<Pick<Ticket,'summary'|'description'|'assignee'|'labels'|'storyPoints'|'issueType'>> }
  | { type: 'ticket.move';     id: IssueId; epicId: IssueId | null; index?: number }
  | { type: 'ticket.transition'; id: IssueId; status: string }
  | { type: 'ticket.discardNew'; id: IssueId }          // only for NEW-* items
  | { type: 'link.add';        from: IssueId; to: IssueId; linkType: 'blocks' }
  | { type: 'link.remove';     from: IssueId; to: IssueId; linkType: 'blocks' }
  | { type: 'timeline.set';    timeline: TimelineConfig };

interface Batch {
  id: string;                         // server-assigned
  author: { name: string; kind: 'human' | 'agent' };
  baseVersion?: number;               // state version the author was looking at
  reason?: string;                    // natural-language request (agent batches)
  askedBy?: string;                   // facilitator / person who asked
  atomic?: boolean;                   // default true for CLI, false for browser
  ops: Op[];
}
```

### Server handling of a batch
1. Reject everything if `state.frozen` (error `FROZEN`).
2. Validate each op with zod, then semantically: ids exist, epic exists, status is a valid
   transition target from `snapshot.workflow`, no link cycles to self, dates `start <= due`, etc.
3. **Conflict check (field-level last-writer-wins with protection):** if `baseVersion` is given and a
   field the op touches has `meta.version > baseVersion` **and** a different author, that op is
   **skipped** with reason `STALE_FIELD` ("PROJ-127 summary edited by James at v59"). Human browser
   edits are always fresh, so this mostly protects human work from agent batches.
4. Soft locks: if an id is claimed by another client, ops on it are rejected with `LOCKED` (claims
   expire; see §5).
5. `atomic: true` → any rejection rejects the whole batch. `atomic: false` → apply the valid ops,
   report the rest.
6. Apply via the pure reducer, bump `version`, update `meta`, append the batch (with results) to
   `workspace/oplog.jsonl`, broadcast to all clients, schedule the mirror write.
7. Respond with `{ batchId, version, applied: [...], rejected: [{ op, code, message }], skipped: [...] }`.

### Undo
`undo(batchId)` computes inverse ops from the oplog entry (the reducer records previous values) and
submits them as a new batch authored by whoever pressed undo. Undo is refused if a later batch
touched the same fields (report which).

---

## 5. Real-time protocol

### Websocket (`/ws`)
Client → server:
- `hello { name, kind: 'human'|'agent', clientId }`
- `batch { batch }`
- `presence { selection?: IssueId[], dragging?: IssueId | null }`
- `claim { ids, note?, ttlSec? }`, `release { ids }`

Server → client:
- `welcome { state, snapshot, snapshotSummary, recent, presence, claims, version }` (`snapshot` is the
  base Jira snapshot, for "differs from Jira" and valid choices; `recent` the last 100 applied batches)
- `batch.applied { batch, results, version }` (to everyone, including sender)
- `batch.result { requestId, results }` (to sender, for optimistic rollback)
- `presence { clients: [...] }`, `claims { claims: [...] }`
- `freeze { frozen, changeset }`, `snapshot.reloaded { summary, state }`, `apply.progress { log }`
- `snapshot.available { summary }`: a newer `snapshot.json` is on disk (offered, not auto-merged,
  unless frozen, where it is the post-apply re-pull and is reloaded straight away)
- `error { code, message }` for malformed messages or a message before `hello`

Messages are JSON objects with a `type` field (`{ "type": "hello", ... }`); schemas and types live in
`packages/shared/src/protocol.ts`.

Browser applies its own ops optimistically, then reconciles on `batch.result` (rollback rejected
ops). Dragging sends `presence.dragging`, which renders as a soft lock for others (teal outline +
"Priya moving"), and the server rejects other writes to that id until drag ends or 10 s pass.

### HTTP API (used by the CLI; also handy for debugging)
- `GET  /api/status` → version, frozen, clients, claims, snapshot pulledAt, pending change count
- `GET  /api/state` → full state; `GET /api/epics/:id` → epic + tickets; `GET /api/tickets/:id`
- `POST /api/batch` → body `Batch` → results (same shape as §4)
- `POST /api/claims` / `DELETE /api/claims` → claim/release with TTL (default 5 min)
- `POST /api/undo` → `{ batchId }`
- `GET  /api/changeset` → current changeset preview (computed, not written)
- `POST /api/freeze` / `POST /api/unfreeze`
- `POST /api/snapshot/reload` → re-read `workspace/snapshot.json`

---

## 6. Freeze → changeset → apply → re-pull

1. **Freeze** (button or `trellis freeze`): server sets `frozen`, rejects all batches, writes
   `workspace/.lock`, computes and writes `workspace/changeset.json`.
2. **Changeset** = diff(snapshot, roadmap), ordered so dependencies resolve:
   epic.create → ticket.create → moves (parent) → field updates → transitions → epic dates →
   link.add → link.remove.
   Each op carries `before` (snapshot value) and `after`, plus `reasons`: the `reason`/`askedBy` of
   every agent batch that touched that item (posted as Jira comments). Epic dates and epic moves of
   existing tickets are **comment-only** (acli can't edit due date or parent): compared with
   `state.acknowledged` (what Jira was last told) and marked acknowledged on the re-pull. Ops that cancel out
   during the session produce nothing (diff, not op replay).
3. **Apply** (`pnpm jira:apply`, run by the facilitator's agent on the facilitator's machine):
   - `--dry-run` (default): fetch each target's current Jira values, compare with `before`, print
     the plan and any **drift** (Jira changed since the snapshot). Writes `workspace/apply-plan.json`.
   - Drift is resolved in the UI (Freeze screen: "Keep Jira value" / "Overwrite") or with
     `--on-drift skip|overwrite`. Default: skip and report.
   - `--yes`: execute in order through the acli adapter. Map temp IDs to real keys as they are
     created. Append each result to `workspace/apply-log.json` **immediately**, so a rerun resumes
     and never repeats a completed step (idempotent by changeset id + op index).
   - Never deletes issues. `ticket.discardNew` ops never reach Jira.
   - Always posts one comment per changed issue: notes for comment-only changes plus captured
     requests. Writes need `--yes --confirm-project <KEY>`; the dry run writes `apply-plan.json`,
     which the server streams to the Freeze screen; drift choices go to `drift-decisions.json`.
4. **Re-pull** (`pnpm jira:pull`): new `snapshot.json`; the server watches it, reloads, rewrites
   NEW-* ids to real keys using `apply-log.json`, recomputes the changeset (should be empty or only
   skipped drift), and offers **Unfreeze**.

The server watches `apply-log.json` to show progress on the Freeze screen.

---

## 7. Jira integration (`packages/jira`)

- Jira Cloud, **team-managed or company-managed** project. Trellis relies only on fields every
  project has and never on exact output shapes or hard-coded field ids (see
  `docs/jira-mapping.md`, "Principle"). Access through the facilitator's **Atlassian CLI**
  (the same one their agent skill uses), wrapped in a small adapter:

  ```ts
  interface JiraAdapter {
    searchIssues(jql: string, fields: string[]): Promise<RawIssue[]>;
    getIssue(key: string, fields: string[]): Promise<RawIssue>;
    createIssue(input): Promise<{ key: string }>;
    updateFields(key, fields): Promise<void>;
    transition(key, toStatus): Promise<void>;
    addLink(from, to, type) / removeLink(...): Promise<void>;
    addComment(key, body): Promise<void>;          // optional, for captured reasons
    listTransitions(key), listAssignableUsers(projectKey)
  }
  ```

- **Which Jira comes from environment variables, never from code or committed config:**

  | Variable | Example | Used by |
  |---|---|---|
  | `JIRA_SITE` | `acme.atlassian.net` | pull, apply (and passed to `acli` where it needs a site) |
  | `JIRA_PROJECT_KEY` | `PROJ` | pull (JQL scope), apply (target project), server (display) |

  Loaded from the process env or a gitignored `.env` (via `dotenv`); `.env.example` documents them.
  Scripts fail fast with a clear message if `JIRA_SITE` or `JIRA_PROJECT_KEY` is missing.
  `snapshot.json` records the site and project key it came from, and apply refuses to run if they
  don't match the current env (prevents applying one project's changeset to another).
  The project is a sandbox for now, so testing and real use target the same `JIRA_PROJECT_KEY`.
  **Apply guard:** `apply --yes` always also requires `--confirm-project <KEY>` matching
  `JIRA_PROJECT_KEY`.
- `acli` is invoked with `execFile` (never a shell string), JSON output parsed and validated with zod.
- **Phase 0 decided the commands** and mapping (results in `docs/jira-mapping.md`): epics are the
  issue type at hierarchy level 1, children via `parent`, link type `Blocks`, done-ness by status
  category. Start date and story points are **Trellis-owned** (kept in Trellis state, excluded from
  the changeset, preserved across re-pulls). No `config.json`: nothing project-specific is hard-coded.
- If the CLI cannot do something (e.g. links or a custom field), stop and report it. Do not silently
  switch to raw REST; the facilitator decides.
- Descriptions: Jira Cloud uses ADF. v1 converts ADF ↔ plain text/markdown for display and only
  writes descriptions the user actually edited.
- Credentials never enter the repo, the workspace files or the container.
- **Run pull/apply on the facilitator's machine**, where `acli` is authenticated, against the
  `workspace/` folder (a bind mount when the server runs in Docker).

---

## 8. The CLI (`packages/cli`, bin `trellis`)

Config: `TRELLIS_URL` (default `http://localhost:8080`: the server listens there in dev and prod;
`:5173` also works in dev through Vite's proxy),
`TRELLIS_AGENT_NAME` (default `Claude Code`), `TRELLIS_FACILITATOR` (used as default `--asked-by`).
Every command supports `--json`; exit codes: 0 ok, 2 partially applied, 3 rejected, 4 frozen,
5 server unreachable.

```
trellis status                                   # version, frozen, people, claims, pending changes
trellis get [epic|ticket] <id>                   # read
trellis list epics | tickets [--epic ID] [--filter text]
trellis snapshot-diff [<id>]                      # how an item differs from Jira
trellis claim <ids…> [--note …] [--ttl 5m]        # soft lock + presence; release <ids…>
trellis epic create|update|dates|transition|reorder …   # dates: --start/--due or --shift 1m|-2w|1q
trellis ticket create|update|move|transition|discard …
trellis link add|remove <from> blocks <to>
trellis batch [--base N] [--reason "…"] [--asked-by NAME] [--non-atomic] < ops.json
trellis undo <batchId>
trellis watch [--json] [--limit N]               # stream batches/presence; --limit 1 = wait for next change
trellis freeze | unfreeze | changeset
```

Run it in the repo as `pnpm -s trellis …` (pnpm echoes the script to stderr; stdout stays clean for
`--json`). Writes resolve `--assignee` by account id, name or a unique name prefix from the people
on tickets. Single-op commands are sugar over `POST /api/batch`. All agent writes carry `author.kind = 'agent'`
plus `reason`/`askedBy` when given. A CLI that issues writes registers presence as an agent client
(shown with the plum treatment) for as long as it has an active claim or watch.

### Agent instructions (`.claude/skills/trellis/SKILL.md` and `AGENTS.md`)
- Always `trellis status` first; stop if frozen.
- Read before writing (`get`/`list`), `claim` before multi-item changes, release after.
- Prefer one `batch` per spoken request, with `--base`, `--reason` (the request verbatim or close
  paraphrase) and `--asked-by`.
- On `STALE_FIELD`, re-read and ask the facilitator rather than forcing.
- Never edit files in `workspace/` directly. Never run `jira:apply --yes` without the facilitator
  confirming the dry-run output in chat.

---

## 9. Frontend (`apps/web`)

Four screens, matching the design canvas (export the artboards to `docs/design/` as PNGs and treat
them as the visual reference; `docs/brief.md` describes each screen's key moments and the colour
meanings):

1. **Live session (timeline)** — top bar (project, snapshot info, live pill, avatars, "Changes vs
   Jira" count, "Freeze for apply"); toolbar (Timeline/Changes/Activity view toggle, Scale select,
   From date, filter, + Ticket, + Epic); timeline grid with a sticky header, 250 px epic label
   column, epic bars (drag to move, drag edges to resize, snap to scale), expandable rows of ticket
   cards (drag between epics/reorder), ochre "now" column; right rail activity feed + workspace info.
2. **Ticket detail** — right-hand panel: summary, epic, status (valid transitions only), assignee,
   story points, labels, description, dependencies (add/remove), "Differs from Jira" box with
   per-field revert. Left: epic header (dates vs Jira dates) and dependency chain with a warning
   when a dependency points backwards in time. Shows who else is viewing.
3. **Agent batch** — plum banner when an agent batch lands ("Claude Code applied batch #3 · asked
   by Shaun"), items it touched get plum dotted outlines for ~30 s, side panel with the captured
   request, results (applied / rejected / kept human edit) and the CLI command summary, Undo batch.
4. **Freeze & apply** — locked header, 5-step progress (Frozen → Changeset written → Waiting for
   agent → Re-pull → Unfrozen), drift conflicts with Keep/Overwrite, changeset table (operation,
   target, change, by), hand-off panel (files, commands, live apply log, Copy agent prompt).

Accessibility: real buttons/inputs/labels, keyboard move for bars and cards (arrow keys shift by one
scale unit; Enter opens detail), 44 px touch targets, visible focus, colour never the only signal
(tags/labels accompany every colour state).

---

## 10. Design tokens

Base palette (coolors): `#CB997E` `#DDBEA9` `#FFE8D6` `#B7B7A4` `#A5A58D` `#6B705C`, plus four
accents. Fonts: **IBM Plex Sans** (UI), **IBM Plex Mono** (keys, code).

| Token | Value | Use |
|---|---|---|
| `--bg` | `#FFF3E8` | page ground (light tint of `#FFE8D6`) |
| `--surface` | `#FFFBF6` | panels, cards |
| `--border` | `#E6CDB9` | borders |
| `--line` | `#F2E1D2` | row dividers |
| `--ink` | `#2F3128` | text |
| `--ink-muted` | `#5E6250` | secondary text |
| `--structure` | `#4F5343` | primary buttons, frozen header (olive family) |
| `--people` | `#3E6A70` / tint `#D3E2E1` / text `#2C4E53` | presence, selection, soft locks |
| `--changed` | `#B97A58` (outline), `#CB997E` (border) / tint `#F8E3D4` / text `#7A4A2E` | differs from Jira |
| `--agent` | `#8E6C8A` (outline), `#7D5A79` (solid, white text) / tint `#EADFE8` / text `#5A3D57` | agent changes, dotted outline |
| `--warn` | `#C9963A` / tint `#F5E6C4` / text `#6B4E14` | now marker, warnings, drift |
| `--error` | `#9E4436` / tint `#F3D8D2` / text `#7E3226` | rejected, errors |
| Epic fills | `#DDBEA9`, `#D3E2E1`, `#F1D3C0`, `#EADFE8`, `#F5E6C4` | rotate per epic, dark text of same hue |

New items (temp ids): 1 px **dashed** border. Agent-touched items: 2 px **dotted** plum outline.
Changed vs Jira: terracotta outline on bars, 3 px inset left bar on cards, dot on epic labels.

---

## 11. Persistence, config and Docker

- `workspace/` holds: `snapshot.json`, `roadmap.json` (mirror), `state.json` (full state incl.
  `meta`, the server's own restore file), `oplog.jsonl`, `changeset.json`, `apply-plan.json`,
  `apply-log.json`, `drift-decisions.json`, `.lock`, `AGENTS.md`.
- On boot: load `state.json` if present; otherwise build state from `snapshot.json`. If the snapshot
  is newer than the state's base, show a "New Jira snapshot available — reload?" prompt instead of
  auto-merging. `state.json` embeds the snapshot the session is based on, so the changeset and the
  reload merge still have the right base after `snapshot.json` is replaced while the server is down.
- Reload merges each core field three ways (base snapshot, new snapshot, roadmap): untouched fields
  take Jira's new value, Trellis edits are kept, Trellis-owned fields always kept, `NEW-*` ids
  renamed to real keys from `apply-log.json` (`shared/src/rebase.ts`).
- Atomic file writes (write temp + rename).
- Env: `PORT` (8080), `WORKSPACE_DIR` (`./workspace`), `HOST` (`0.0.0.0` for LAN), plus
  `JIRA_SITE`, `JIRA_PROJECT_KEY` (§7). The server only needs
  `JIRA_PROJECT_KEY` (optional, for display and a mismatch warning against the snapshot); the
  Jira variables matter to the scripts on the facilitator's machine.
- **Dockerfile** (repo root, builds from the monorepo): multi-stage `node:22-alpine`;
  `corepack enable`; copy `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc` and every
  `package.json` first, then `pnpm install --frozen-lockfile --ignore-scripts` for layer caching;
  copy sources; `pnpm --filter @trellis/server... --filter @trellis/web build` (`tsc -b` + Vite).
  Runtime stage: `pnpm --filter @trellis/server deploy --prod --ignore-scripts /app` (bundles
  `@trellis/shared` as a real dependency), copy the web build into the server's static folder, run
  plain `node` on compiled output as a non-root user, no `tsx` in production. One port for SPA +
  API; `VOLUME /workspace`; `HEALTHCHECK` on `/api/status`. Single replica only (state is in
  memory). `acli`, the CLI and the jira package are **not** in the image.
- **`compose.yaml`** for running on a laptop or a LAN box:

  ```yaml
  services:
    trellis:
      build: .
      image: trellis:local
      ports: ["${PORT:-8080}:8080"]
      env_file: [.env]               # JIRA_PROJECT_KEY etc.; optional for the server
      environment:
        WORKSPACE_DIR: /workspace
        HOST: 0.0.0.0
      volumes:
        - ./workspace:/workspace     # bind mount so pull/apply on the host see the same files
      restart: unless-stopped
      healthcheck:
        test: ["CMD", "wget", "-qO-", "http://localhost:8080/api/status"]
        interval: 15s
  ```

  - The workspace is a **bind mount**, not a named volume, because `pnpm jira:pull` / `jira:apply`
    and the facilitator's agent run on the host and must read and write the same files. File
    watching on the snapshot and apply log must work across the bind mount; use polling as a
    fallback (`WATCH_POLL=1`) for Docker Desktop on macOS/Windows.
  - Never `--scale` this service; the compose file sets no replicas and the README says why.
  - Optional `dev` profile (`docker compose --profile dev up`): `node:22-alpine` with the repo
    mounted, `node_modules` in an anonymous volume, running
    `corepack enable && pnpm install --frozen-lockfile --ignore-scripts && pnpm dev`, ports 5173 and
    8080. Only add it if it works cleanly with `ignore-scripts`; otherwise document plain `pnpm dev`.
  - Root scripts: `pnpm docker:up` (`docker compose up -d --build`), `pnpm docker:down`,
    `pnpm docker:logs`.
- The same Dockerfile deploys to Azure Container Apps (or similar) later: one replica, a mounted
  file share at `/workspace`, port 8080.
- Scripts (root `package.json`): `pnpm dev` (server + Vite with proxy), `pnpm build`, `pnpm start`,
  `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm jira:pull`, `pnpm jira:apply`, `pnpm seed`
  (loads a fixture snapshot). The CLI is exposed as `pnpm trellis …` in the repo and can be linked
  globally with `pnpm link --global` from `packages/cli`.

---

## 12. Testing

- `shared`: reducer tests per op, validation tests, diff/changeset ordering tests, conflict
  (`STALE_FIELD`) tests, undo inverse tests. Fixtures in `packages/shared/fixtures/` built from the
  Phase 0 sanitised snapshot.
- `server`: integration tests with two websocket clients + HTTP batch (agent) — optimistic rollback,
  broadcast, claims, freeze rejection, persistence restart.
- `cli`: commands against an in-process server; `--json` output snapshot tests.
- `packages/jira`: adapter mocked (record/replay JSON from Phase 0); dry-run, drift, resume-after-
  failure tests. Real writes only against `JIRA_PROJECT_KEY`
  (currently a sandbox project).
- Optional: Playwright smoke test of the four screens.

---

## 13. Phases

Work one phase at a time. At the end of each phase: run tests, summarise what changed, and stop
for review.

**Phase 0 — Jira discovery (read-only, no code beyond scripts/notes)**
- Scaffold the bare monorepo: root `package.json` (with `packageManager`), `pnpm-workspace.yaml`,
  `.npmrc` (`ignore-scripts=true`), `tsconfig.base.json`, solution `tsconfig.json`, `.gitignore`,
  `.dockerignore`, and empty `apps/server`, `apps/web`, `packages/shared`, `packages/cli`,
  `packages/jira` packages that typecheck.
- Create `.env.example` and the env loader in `@trellis/jira`; read `JIRA_SITE` /
  `JIRA_PROJECT_KEY` from `.env`. Discovery scripts live in `packages/jira/src/discovery/`.
- Read the facilitator's Atlassian CLI skill and confirm `acli` is authenticated for `JIRA_SITE`.
- Explore the project: issue types, epics and their children, workflows/transitions, fields
  (start date, story points ids), link types, assignable users, rough counts.
- Write `docs/jira-mapping.md` (field ids, commands that work, gaps) and a **sanitised** fixture
  snapshot (realistic structure, fake names/text) for tests.
- ✅ Done when the mapping doc answers every "decided in Phase 0" item in §7 and lists any CLI gaps.

**Phase 1 — Shared model**: types, zod schemas, reducer, validation, diff → changeset, undo
inverses, fixtures, tests. ✅ All §4/§6 rules covered by tests.

**Phase 2 — Server**: state load/persist, websocket + HTTP API, batches, conflicts, claims,
presence, oplog, mirror writer, freeze/changeset, snapshot reload. ✅ Integration tests pass; two
terminals with `wscat`/curl can collaborate.

**Phase 3 — Web UI**: tokens + layout from §9/§10, timeline with scales, drag/resize/snap, ticket
cards and moves, ticket detail panel, activity feed, agent banner, Changes view, Freeze screen.
✅ Two browsers editing live; matches `docs/design/` closely; keyboard operable.

**Phase 4 — CLI + agent skill**: all §8 commands, `--json`, exit codes, presence, `SKILL.md` and
`AGENTS.md`. ✅ An agent can carry out "split PROJ-140 into three tickets and push Notifications
back a month" in one batch with reason captured, visible live in the browser.

**Phase 5 — Jira pull/apply**: adapter over `acli`, pull → snapshot, apply dry-run, drift, `--yes`
execution with resume, temp-id mapping, optional reason comments, env checks and the
`--confirm-project` guard. ✅ Full loop against `JIRA_PROJECT_KEY`: pull → edit → freeze → dry-run → apply → pull → changeset empty → unfreeze.

**Phase 6 — Packaging**: Dockerfile, `.dockerignore`, `compose.yaml`, `docker:*` scripts, README
(local run, compose run, facilitator runbook: pull → session → freeze → apply → pull), seed command.
✅ `docker compose up -d --build` serves the app on the LAN; `pnpm jira:pull` on the host updates
the running session through the bind-mounted workspace; the image contains no dev dependencies,
no `.env` and no workspace data.

---

## 14. Guardrails for the implementing agent

- Never write to Jira outside Phase 5's apply script, and only after the facilitator approves a
  dry-run in chat. Phase 0 is strictly read-only.
- Never delete Jira issues or links that the changeset doesn't explicitly remove.
- Keep real Jira data out of git: only sanitised fixtures are committed; `workspace/*` and `.env`
  are ignored. Never hard-code a site or project key; always read the env vars.
- Ask before adding dependencies beyond those named here, and before deviating from this plan's
  data model or protocol.
- Use pnpm only (never npm or yarn commands, never a `package-lock.json`). Never turn off
  `ignore-scripts`, and never run a dependency's install script by hand to work around it; ask.
- Every phase ends with `pnpm typecheck`, `pnpm lint` and `pnpm test` passing.
