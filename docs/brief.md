# Trellis — Project Brief

> Exported from the live doc [Trellis — Project Brief](https://claude.ai/code/artifact/faa633ff-b2bb-4ca5-a758-2ea2bda6e3fe)
> on 2026-10-17 (rev 12). The live doc is the source; re-export when it changes.

Oct 17, 2026 · @Shaun

## What Trellis is

Trellis is a small web app for building a delivery roadmap together, live, on top of our Jira project. Epics are bars on a timeline, tickets sit under them, and everyone in the session sees changes as they happen.

It solves the collaborative part we struggle with today: agreeing the plan visually as a group, then getting those decisions back into Jira without anyone retyping tickets.

- **The app has no AI in it.** It is a real-time editor, a command-line tool and two Jira scripts.
- **The facilitator's agent** (Claude Code or GitHub Copilot) joins the session through the `trellis` CLI, so spoken or typed requests become live edits.
- **Jira only changes at the end,** after the group agrees and the facilitator approves a dry run.

## How a session works

_(The live doc embeds a diagram here, "a Trellis session · 7 steps, one loop", which does not survive Markdown export. See docs/PLAN.md §6 for the freeze → changeset → apply → re-pull loop.)_

Everything before Freeze happens only in Trellis; Jira changes once, in the Apply step, after the facilitator has seen the dry run.

## Key decisions

| Decision | What we chose | Why |
| --- | --- | --- |
| Collaboration | Real-time over websockets; the server holds the one true copy | Everyone sees the same plan instantly; simple conflict rules |
| Conflicts | Last writer wins per field, but agent edits never overwrite a newer human edit | People's work is protected; rare clashes are visible |
| Agent access | `trellis` CLI, not direct file edits; `roadmap.json` is a read-only mirror | Each change is validated instantly and the agent gets clear errors |
| Who runs the agent | Whoever is facilitating; no request box in the app for now | Keeps the app simple and agent-free |
| Captured requests | Every agent batch stores the request in plain words and who asked | We keep a record of why things changed |
| Time axis | Configurable scale (months by default; quarters, weeks or custom), not sprints | We don't work to sprints; epics store real dates |
| Jira mapping | Timeline = epic start and due dates; Jira Cloud, company-managed | Matches how our project is set up |
| Jira access | Scripts wrap the facilitator's Atlassian CLI; agent can also use the CLI skill for one-offs | One login, consistent behaviour |
| Safety | Dry run first, drift check, resumable apply; never deletes issues; extra flag for the real project | Nothing reaches Jira by accident |
| Config | `JIRA_SITE`, `JIRA_PROJECT_KEY`, `JIRA_SANDBOX_KEY` as env vars | No real keys in code or git |
| Hosting | Local or LAN, no login for now; Docker Compose; single instance | Fits a meeting-room tool; live state is in memory |

## Design screens

The four key screens are on the [Trellis Screens design canvas](https://claude.ai/artifact/Tc86u1GSQqM1Y6pPLUTWuz). Share the canvas with the team before linking it onward; it is private until then. For Claude Code, export the screens as images into `docs/design/` in the repo.

| Screen | What it shows | Key moments |
| --- | --- | --- |
| 1 · Live roadmap session | Epics as bars across months, an expanded epic with its ticket cards, an activity feed | Who's in the session, a soft lock while someone drags, the count of changes vs Jira |
| 2 · Ticket detail and dependencies | An editing panel beside the epic, with the dependency chain | Fields that differ from Jira, revert to Jira values, a warning when a dependency runs backwards in time |
| 3 · Facilitator's agent applies a batch | A banner and side panel when the agent's changes land | The request in the facilitator's words, what was applied, kept or rejected, the CLI commands, undo |
| 4 · Freeze and apply | The locked session and the changeset ready for Jira | Five-step progress, a drift conflict to resolve, the hand-off panel with files, commands and apply log |

## Visual language

Each colour means one thing, so a glance tells you who changed what. The base is our [coolors palette](https://coolors.co/palette/cb997e-ddbea9-ffe8d6-b7b7a4-a5a58d-6b705c), with four muted accents for meaning. Type is IBM Plex Sans, with IBM Plex Mono for ticket keys.

| Colour | Hex | Means |
| --- | --- | --- |
| Cream | `#FFE8D6` (page tint `#FFF3E8`) | Page background |
| Tan | `#DDBEA9` | Borders, lines, one epic fill |
| Olive | `#6B705C` | Structure: buttons, headers, the frozen bar |
| Teal | `#3E6A70` | People: presence, selection, soft locks |
| Terracotta | `#CB997E` | Differs from the Jira snapshot |
| Plum | `#8E6C8A`, dotted outline | Changed by the facilitator's agent |
| Ochre | `#C9963A` | Now marker, warnings, drift |
| Brick | `#9E4436` | Errors and rejected edits |

A dashed border marks a new item that only exists in Trellis so far. Full-strength colours are only for small marks; large areas use light tints.

## Tech stack and repo

Trellis is one pnpm monorepo, TypeScript throughout, with install scripts disabled (`ignore-scripts=true`).

| Package | What it is |
| --- | --- |
| `@trellis/web` | Svelte 5 single-page app, built with Vite |
| `@trellis/server` | Node 22 and Fastify, websockets, holds the live state, serves the app |
| `@trellis/shared` | Shared types, validation and the logic for edits and changesets |
| `@trellis/cli` | The `trellis` command the facilitator's agent uses |
| `@trellis/jira` | Pull and apply scripts wrapping the Atlassian CLI |

It runs with `pnpm dev`, or `docker compose up` on a laptop or LAN box. The working files (snapshot, roadmap mirror, changeset, logs) live in a `workspace/` folder shared between the container and the facilitator's machine.

## Build phases

Claude Code builds Trellis in seven phases, stopping for review after each. The full spec is `docs/PLAN.md` in the repo; `KICKOFF_PROMPT.md` holds the prompt that starts Phase 0 and the prompts for later phases.

1. **Phase 0 · Jira discovery.** Read-only look at our project: field ids, workflows, link types, what the Atlassian CLI can and can't do. Also sets up the empty monorepo.
2. **Phase 1 · Shared model.** Data types, validation, edit logic, changeset logic, tests.
3. **Phase 2 · Server.** Live state, websockets, conflicts, soft locks, freeze.
4. **Phase 3 · Web app.** The four screens, drag and drop, keyboard support.
5. **Phase 4 · CLI and agent skill.** The `trellis` command and the instructions that teach an agent to use it.
6. **Phase 5 · Jira pull and apply.** Tested end to end against the sandbox project only.
7. **Phase 6 · Packaging.** Dockerfile, Docker Compose, README and the facilitator runbook.

## Open questions and next steps

- [ ] Create the repo, add `docs/PLAN.md`, the `.env` and the exported screens
- [ ] Pick or create the sandbox Jira project for testing
- [ ] Run Phase 0 and review what the Atlassian CLI can't do
- [ ] Share the design canvas and this brief with the team

Open questions:

- Should captured requests also be posted as comments on the Jira tickets they changed?
- Will we later want agents to edit `roadmap.json` directly, or a request box in the app?
- When we move beyond the LAN, which sign-in do we use (for example Entra on Azure Container Apps)?
