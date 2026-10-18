# Trellis

_Epics are the frame, tickets grow along it._

A small, local-first web app for building a delivery roadmap together, live, on top of a Jira
project. Epics are bars on a timeline, tickets sit under them, and everyone in the room edits the
plan in real time. The facilitator's coding agent (Claude Code or GitHub Copilot) joins through the
`trellis` CLI, so spoken or typed requests become live edits. When the group agrees, the session is
frozen, and the agent applies the changes to Jira through the Atlassian CLI.

**The app contains no AI.** It is a real-time editor, a CLI and two Jira scripts.

| Document | What it's for |
|---|---|
| [`docs/brief.md`](docs/brief.md) | Why Trellis exists, the session flow and the key decisions |
| [`docs/PLAN.md`](docs/PLAN.md) | Architecture, data model, protocol, phases |
| [`docs/jira-mapping.md`](docs/jira-mapping.md) | How Trellis reads and writes Jira; CLI gaps and decisions |
| [`AGENTS.md`](AGENTS.md) / [`.claude/skills/trellis`](.claude/skills/trellis/SKILL.md) | How an agent drives the `trellis` CLI |

## Requirements

- **Node 22+** with Corepack (`corepack enable`); pnpm is pinned by `packageManager`.
- For Jira: the **Atlassian CLI** (`acli`) on the facilitator's machine, logged in with
  `acli jira auth login --web`. Not needed to try Trellis with sample data.
- For the container: Docker with Compose v2 (on Windows/WSL, turn on WSL integration in Docker Desktop).

Install with `pnpm install`. Install scripts are disabled (`ignore-scripts`); nothing needs them.

## Configuration

Copy `.env.example` to `.env` (gitignored) and fill in:

| Variable | Example | Used by |
|---|---|---|
| `JIRA_SITE` | `acme.atlassian.net` | `jira:pull`, `jira:apply` |
| `JIRA_PROJECT_KEY` | `PROJ` | pull/apply (which project); server (mismatch warning only) |
| `PORT` | `8080` | server |
| `HOST` | `0.0.0.0` | server (`127.0.0.1` to stay local) |
| `WORKSPACE_DIR` | `./workspace` | server and scripts |
| `WATCH_POLL` | `1` | poll files instead of watching (Docker Desktop on macOS/Windows) |
| `TRELLIS_URL`, `TRELLIS_AGENT_NAME`, `TRELLIS_FACILITATOR` | `http://localhost:8080`, `Claude Code`, `Shaun` | the `trellis` CLI |

No site or project key is ever hard-coded or committed. Real Jira data lives only in `workspace/`,
which is gitignored and never enters the Docker image.

## Run it locally

```bash
pnpm install
pnpm seed          # sample project (invented data); or `pnpm jira:pull` for your real project
pnpm dev           # server on :8080, web app on http://localhost:5173 (proxies /api and /ws)
```

In dev, open :5173 (or `http://<this machine>:5173` for the room). The dev server serves only the
API on :8080, so an old `pnpm build` can't show an out-of-date app there.

Open the app in two browser windows with different names and edit in one: the other updates live.
Try the agent side from a terminal:

```bash
pnpm -s trellis status
pnpm -s trellis epic dates PROJ-43 --shift 1m --reason "push Notifications back a month"
```

Production build without Docker: `pnpm build && pnpm start` (one port, :8080, serves the app and API).

## Run it with Docker (laptop or LAN box)

```bash
pnpm docker:up     # docker compose up -d --build
pnpm docker:logs
pnpm docker:down
```

Then open `http://<this machine's address>:8080` from any browser on the network. The `workspace/`
folder is bind-mounted into the container, so `pnpm jira:pull` and `pnpm jira:apply` on the host
update the running session directly. On Docker Desktop for macOS/Windows, if pulls don't show up,
set `WATCH_POLL=1` in `.env` and run `pnpm docker:up` again.

The image contains the compiled server and web app only: no dev dependencies, no `.env`, no
workspace data, no `acli`, no Jira scripts. It runs as a non-root user with a healthcheck on
`/api/status`. The same image runs on any container host (for example Azure Container Apps) with
one replica, a file share mounted at `/workspace`, and port 8080.

**Why one instance:** the live session is held in the server process. Never scale this service
(`--scale`, replicas > 1): two instances would each hold a different session.

## Facilitator runbook

Before the session:

1. `pnpm jira:auth`: checks `acli` is logged in to `JIRA_SITE`.
2. `pnpm jira:pull`: writes `workspace/snapshot.json` from Jira (read-only).
3. Start Trellis (`pnpm docker:up`, or `pnpm dev`) and share the URL with the room. Add your
   delivery date with **+ Milestone** (or `pnpm -s trellis milestone add Delivery 2026-11-09`): the
   default Milestones scale shows the weeks up to it, then the **Deliver later** tray.
4. Open your agent (Claude Code or Copilot) in this repo. It reads `AGENTS.md` / the `trellis` skill.

During the session:

5. People edit in the browser; you ask your agent for bigger changes ("split PROJ-140 into three
   tickets and push Notifications back a month"). Each agent batch shows a plum banner with the
   request, what was applied, kept or rejected, and an **Undo**.
6. **Changes vs Jira** in the top bar shows what will change. The **By 9 Nov** / **Later** chips show
   what makes the milestone; drag work into the tray (or ask: "Notifications won't make 9 Nov, put
   it in deliver later"). In Jira, deferred items get a `deliver-later` label and a comment.

At the end:

7. **Freeze for apply** (or `pnpm -s trellis freeze`): editing locks for everyone and
   `workspace/changeset.json` is written.
8. Ask your agent to apply. It runs **`pnpm jira:apply`** (a dry run: nothing is written) and shows
   you the plan and any drift. Resolve drift on the Freeze screen (**Keep Jira value** / **Overwrite
   with roadmap**) or with `--on-drift skip|overwrite`.
9. Only after you confirm: **`pnpm jira:apply --yes --confirm-project <KEY>`**. Progress appears live
   on the Freeze screen. If it stops part-way, fix the cause and run the same command again: it
   resumes and never repeats a finished step.
10. **`pnpm jira:pull`**: Trellis re-pulls automatically while frozen; the changeset should be empty.
11. **Unfreeze**.
12. When you're done with this roadmap: stop Trellis and `pnpm session:new --label <name>` to archive
    it, so the next session starts clean (see below).

What reaches Jira, and how:

- Creates, summary/description/assignee/labels/type edits, status changes and "blocks" links are
  written directly. Issues are never deleted.
- **Epic dates** and **moving an existing ticket to another epic** can't be edited through `acli`.
  Trellis owns those, and apply posts them as a comment on the issue (with a note to move the
  ticket in Jira by hand). New epics get their due date and new tickets their epic when created.
- Every changed issue gets one comment with the captured requests ("… asked by Shaun").
- Start dates and story points stay in Trellis.

## Starting a new roadmap (and keeping the old one)

The server always resumes the session in `workspace/` (`state.json`), and a new Jira pull is merged
into it. To start a fresh roadmap instead, archive the current session:

```bash
# stop Trellis first (Ctrl-C, or pnpm docker:down)
pnpm session:new --label q1-planning --pull   # archive the old session, pull Jira fresh
pnpm dev                                      # or pnpm docker:up: builds a clean roadmap
```

- The old session moves to `workspace/archive/<date>-<label>/`: `state.json`, `roadmap.json`, the
  batch log, changeset, apply plan and log, drift decisions, plus a copy of its snapshot and a
  `meta.json` (project, version, number of batches, whether it was applied to Jira).
- Without `--pull` the current `snapshot.json` stays for the new session; use `pnpm seed` for sample data.
- `pnpm session:list` shows the current session and every archive, newest first.
- `pnpm session:restore <name>` brings an archived session back (the current one is archived first;
  the archive itself stays). Start Trellis to carry on with it.
- Both refuse while a Trellis server is using the workspace (it would save over the change) or
  while the session is frozen; `--force` overrides.
- Archives are gitignored like the rest of `workspace/`: they hold real Jira data.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | server + Vite with hot reload |
| `pnpm build` / `pnpm start` | production build / run the built server |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | `tsc -b` + `svelte-check` / ESLint / Vitest (all must pass) |
| `pnpm seed [--force]` | sample snapshot into the workspace |
| `pnpm session:new [--label] [--pull]` / `session:list` / `session:restore <name>` | archive the session and start fresh / list / bring one back |
| `pnpm jira:auth` / `jira:pull` / `jira:apply` | check `acli`, pull the project, apply the frozen changeset |
| `pnpm -s trellis …` | the agent CLI (`pnpm -s trellis --help`) |
| `pnpm docker:up` / `docker:down` / `docker:logs` | Compose |

Link the CLI globally with `pnpm build && cd packages/cli && pnpm link --global`, then use `trellis …`.

## Repository layout

```
apps/server     @trellis/server  Fastify + websockets, session state, persistence, freeze
apps/web        @trellis/web     Svelte 5 + Vite single-page app
packages/shared @trellis/shared  data model, reducer, changeset, undo, rebase, protocol (no I/O)
packages/cli    @trellis/cli     the `trellis` command
packages/jira   @trellis/jira    acli adapter, pull, apply, seed (+ Phase 0 discovery scripts)
workspace/                       runtime files (gitignored except AGENTS.md)
docs/                            brief, plan, Jira mapping, design screens
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Browser shows "Can't reach the Trellis server" | Is the server running? In dev, `pnpm dev` starts both. |
| `trellis` exits 5 | Server unreachable: check `TRELLIS_URL` (default `http://localhost:8080`). |
| `trellis` exits 4 | The session is frozen: unfreeze, or finish the apply first. |
| A pull doesn't appear in the running app | Docker Desktop: set `WATCH_POLL=1`. Otherwise use "New Jira snapshot · reload" in the top bar. |
| `jira:apply` refuses to run | Read the message: the session must be frozen, the snapshot must match `JIRA_SITE`/`JIRA_PROJECT_KEY`, and `--yes` needs `--confirm-project <KEY>`. |
| Status shows a project mismatch warning | `JIRA_PROJECT_KEY` differs from the project in `workspace/snapshot.json` (for example after `pnpm seed`). |
