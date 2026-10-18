# Jira mapping (Phase 0 findings)

How Trellis reads and writes Jira through the Atlassian CLI (`acli`, tested with 1.3.39). The project
is always `$JIRA_PROJECT_KEY` on `$JIRA_SITE` from `.env`; no real keys appear in this repo.

Discovery ran against a sandbox project with seeded data (8 issues, all labelled `trellis-seed`).
Scripts are in `packages/jira/src/discovery/`; their raw output goes to the gitignored
`workspace/discovery/`.

## Principle: don't depend on one project's setup

Trellis has to work with any Jira Cloud project, team-managed or company-managed, however its
tickets are configured. So:

- **Use only the fields every project has** (table below). Everything else is optional.
- **Never rely on exact output shapes.** Parse `acli` JSON loosely: zod schemas that ignore unknown
  keys, results either as a bare array or wrapped in an object, and only the fields we need. The same
  data comes back in different shapes from different commands (for example links from `view` and from
  `link list`).
- **Identify things by meaning, not by name.** An epic is any issue type at **hierarchy level 1** in
  the project's `issueTypes` (usually named "Epic", but not guaranteed). Whether a status counts as
  done comes from its **status category** (`new` / `indeterminate` / `done`), not from a status called "Done".
- **No field ids are hard-coded.** Custom fields differ per project. Optional field mappings can be
  added per project later (see "Trellis-owned fields").

## Core fields (read from Jira, written back on apply)

| Trellis | Jira field (from `workitem view --fields '*all' --json`) | Notes |
|---|---|---|
| `id` | `key` | |
| `summary` | `fields.summary` | |
| `description` | `fields.description` | ADF document or plain string. Convert to text, never parse by a fixed shape. |
| `issueType` | `fields.issuetype.name` | Epic = type at `hierarchyLevel` 1 (from `project view`). |
| `status` | `fields.status.name`, `fields.status.statusCategory.key` | Done-ness by category. |
| `epicId` | `fields.parent.key` | Works for team-managed and current company-managed Cloud projects. Seen shape: `{id,key,self,fields}`. |
| `assignee` | `fields.assignee.accountId` / `.displayName` | Can be `null`. |
| `labels` | `fields.labels` | Without `deliver-later`, which is read as `deferred` (next row). |
| `deferred` (epics and tickets) | `fields.labels` contains `deliver-later` | Read on pull for epics too (Trellis epics have no other labels). Written by apply with `edit --labels` / `--remove-labels`, `create --label`. |
| `links` | `fields.issuelinks[]`: `type.name`, `outwardIssue.key` or `inwardIssue.key`, `id` | Keep the link `id`: delete needs it. |
| Epic `dueDate` | `fields.duedate` | Read on pull; set on create. Afterwards Trellis-owned (acli can't edit it): changes go to Jira as comments. |

## Trellis-owned fields

**Start date** and **story points** are tracked inside Trellis only. The roadmap shows them, edits
them and keeps them in its own state. They are not read from Jira, and the changeset doesn't write
them back.

- Why: their custom field ids differ per project, `acli` has no command to list fields by name, and
  `workitem edit` can't set custom fields anyway.
- Consequence: a re-pull replaces `snapshot.json`, so these values have to live in Trellis state
  (`state.json` / `roadmap.json`), keyed by issue key, and survive a reload. They must never show up
  in the changeset as "differs from Jira".
- Later, optionally: a per-project mapping (`field id → Trellis field`) could sync them where the
  CLI allows it. On create, `--from-json` does accept custom fields through `additionalAttributes`.

## Project facts found

| Item | Finding |
|---|---|
| Project style | Team-managed (`style: next-gen`, `simplified: true`). PLAN.md assumed company-managed; the core fields above work for both. |
| Issue types | Epic (level 1); Story, Task, Bug, Feature (level 0); Subtask (level −1, out of scope for v1). |
| Epic → child | `parent` field; `parent = <EPIC-KEY>` works in JQL. Tickets without an epic are allowed. |
| Statuses seen | To Do, In Progress, Done on Epic, Story, Task and Bug (one simple workflow). Transitions to and from each worked, including Done → To Do on an epic. |
| Link types | Blocks, Cloners, Duplicate, Relates. Use the **name** `Blocks`. **Careful:** `link create --type Blocks --out A --in B` creates "**B blocks A**" (Jira REST naming: the inward issue is the blocker), although acli's success message prints "A Blocks B". Verified on the sandbox in Phase 5. |
| Assignable users | Can't be listed with `acli` (gap). Assignees can be set by account id. |
| Volume | Sandbox: 2 epics, 8 issues. Pull must page through results and fetch each issue (see gaps). |

## JiraAdapter → acli commands

All commands are run with `execFile` (no shell). "JSON" means the command has a `--json` flag.

| Adapter method | Command | JSON | Status |
|---|---|---|---|
| `searchIssues(jql)` | `acli jira workitem search --jql "<jql>" --paginate --json` | yes | Verified. `--fields` only accepts a fixed set (it rejects `duedate` and `parent`), so use search for **keys only**, then `getIssue` for each one. Use `--count` for totals. |
| `getIssue(key)` | `acli jira workitem view <key> --fields '*all' --json` | yes | Verified. |
| `createIssue(input)` | `acli jira workitem create --from-json <file> --json` | yes | Verified. Accepts `projectKey`, `type`, `summary`, `description` (ADF), `labels`, `assignee`, `additionalAttributes` (`duedate` verified; custom fields by id). The output is the whole created issue, so read its `key`. |
| (create under an epic) | `acli jira workitem create … --parent <EPIC> --json` | yes | Verified with flags. In `--from-json`, `parentIssueId` is documented "for sub-tasks only", so check whether one call can set both parent and due date in Phase 5; otherwise create with flags. |
| `updateFields(key, fields)` | `acli jira workitem edit --key <key> [--summary] [--description] [--labels / --remove-labels] [--assignee / --remove-assignee] [--type] --yes --json` | yes | Help only. **Can't** set due date, parent or custom fields (gap). |
| `transition(key, status)` | `acli jira workitem transition --key <key> --status "<name>" --yes --json` | yes | Verified. Target is a status **name**, not a transition id. |
| `addLink(from, to, 'blocks')` | `acli jira workitem link create --out <to> --in <from> --type Blocks --yes` | no | Verified (note the reversed flags). Output is a single text line. |
| `removeLink(...)` | `acli jira workitem link delete --id <linkId> --yes` | no | Help only (a test delete was blocked by Claude Code's auto mode). Needs the link **id**, from `issuelinks[].id` or `acli jira workitem link list --key <key> --json`. |
| `addComment(key, body)` | `acli jira workitem comment create --key <key> --body "<text or ADF>" --json` | yes | Help only. |
| `listTransitions(key)` | — | — | **Missing.** |
| `listAssignableUsers(project)` | — | — | **Missing.** |
| (project info) | `acli jira project view --key <key> --json` | yes | Verified: issue types with hierarchy levels and project style. |
| (link types) | `acli jira workitem link type --json` | yes | Verified: names only. |
| (auth check) | `acli jira auth status` | no | Verified. Plain text that includes `Site: <site>`. |

## CLI gaps (to be decided; no fallback to raw REST has been made)

1. **`edit` can't change due date, parent or custom fields.** Confirmed in Phase 5 with a probe on
   the sandbox: `workitem edit --from-json` rejects every field name for them (`parent`,
   `parentIssueId`, `duedate`, `additionalAttributes`…) before sending anything. **Decided:** epic
   dates are Trellis-owned, and moving an existing ticket to another epic stays in the roadmap.
   Apply posts both as a note in the issue's comment, and the re-pull marks them as acknowledged
   so the changeset empties (see "Phase 5 decisions").
2. **No way to list transitions.** The UI can't know which statuses are reachable. Workaround:
   every type offers every status seen anywhere in the project (team-managed projects usually share
   one workflow; offering only the statuses seen per type was too strict), and apply reports a
   rejected transition as a failed step that a rerun resumes from.
3. **No way to list assignable users.** Workaround: offer the people already assigned to issues in
   the project (from pull), and accept typed account ids.
4. **No way to list fields by name.** That's why start date and story points are Trellis-owned.
5. **Search can't return most fields**, so pull makes one `view` call per issue (N+1). Fine for
   hundreds of issues, slow for thousands; pull should run calls with limited concurrency.
6. **Output shapes vary between commands** (`create` prints the whole issue; `link create` prints one
   line of text; `link list` and `view` describe links differently). The adapter normalises them, and
   tests use recorded output from `workspace/discovery/`.

## Where PLAN.md doesn't fit this setup

- §7 says "company-managed". Make it "team-managed or company-managed"; nothing depends on the
  difference once epics are found by hierarchy level.
- §3 `Epic.startDate` and `Ticket.storyPoints` are Trellis-owned, not Jira fields; §6 changeset
  must skip them.
- ~~§3 `Link` only models `blocks`.~~ Done in Phase 1: any link type is kept, with direction and
  Jira link id; v1 ops only edit Blocks.
- ~~§3 `snapshot.workflow`.~~ Done in Phase 1: statuses per type with categories, the epic type
  name, people seen, and `transitions: null` when unknown (gap 2).
- ~~§6/§7 `epic.setDates` and `ticket.move` are blocked by gap 1.~~ Decided in Phase 5: comments + acknowledged (below).
- §7 `packages/jira/config.json` isn't needed: nothing project-specific is hard-coded.

## Discovery scripts

| Command | What it does |
|---|---|
| `pnpm jira:auth` | Checks that `acli` is installed and logged in to `JIRA_SITE`. |
| `pnpm jira:discover` | Read-only exploration (through a guard that only allows read commands); prints counts, types, statuses and shapes. |
| `pnpm jira:help-audit` | Saves `--help` text for every relevant command. |
| `pnpm jira:fixture` | Regenerates `packages/shared/fixtures/snapshot.sample.json` (all data invented). |
| `seed-sandbox.ts` | One-off writes, approved for the sandbox: seeds an **empty** project; requires `--confirm-project`. |

## Phase 5 decisions (pull and apply)

| Topic | Decision |
|---|---|
| Epic dates | Trellis-owned, like start date. A change is relative to `acknowledged` (what Jira was last told), not the snapshot. Apply posts "Planned dates: … (was …)" as a comment. New epics still get their due date set on create. On re-pull, Jira's due date wins only if Jira changed it and Trellis didn't. |
| Epic moves of existing tickets | Posted as a comment ("Moved to epic … on the roadmap … please move it in Jira"), acknowledged on re-pull. New tickets get their epic on create (`--parent`). |
| Comments | Always. One per changed issue: notes for comment-only changes, plus the captured requests with who asked. |
| Descriptions | Basic Markdown ↔ ADF (`packages/jira/src/adf.ts`): paragraphs, headings, lists, bold, italic, code, links. Richer content is flattened to text on pull; only edited descriptions are written. |
| Drift | Dry run compares each target with live Jira. Decide per step in the Freeze screen (Keep Jira value / Overwrite → `workspace/drift-decisions.json`) or with `--on-drift skip\|overwrite`; undecided drift keeps Jira's value. Changes already in Jira are skipped. |
| Guards | Apply needs a frozen session (`.lock`), a snapshot and changeset from `JIRA_SITE`/`JIRA_PROJECT_KEY`, and `--yes --confirm-project <KEY>` to write. Never deletes issues. |
| Resume | Every step result is appended to `workspace/apply-log.json` immediately; a rerun skips finished steps (by changeset id + step id) and reuses created keys for `NEW-*` ids. |
| Link direction | `acli … link create --out A --in B` creates "B blocks A". The adapter passes `--out <blocked> --in <blocker>`. |

**Verified end to end on the sandbox (2026-10-18):** pull → edit (one batch with every change type)
→ freeze → dry run → `--yes` (3 creates, field edits, a transition, link add and remove, 9 comments)
→ pull → changeset empty → unfreeze.

## Milestones and Deliver later (`docs/plans/milestones.md`)

| Topic | Decision |
|---|---|
| Milestones | Trellis only (`roadmap.json` / `state.json`); never written to Jira. |
| Deferral | The label `deliver-later` (`LATER_LABEL` in `packages/jira/src/normalize.ts`; a constant, not configurable, until a project needs another name). Checked from `acli … edit --help` / `create --help` only: `--labels`, `--remove-labels`, `--label`. |
| Pull | The label sets `deferred` on epics and tickets and is left out of `labels`, so label edits, label drift and the changeset never see it. A deferred epic has no dates in Trellis; Jira's due date is kept as what Jira was told. |
| Apply | A `defer` change (ordered after transitions, before epic dates) is an `edit` adding or removing the label, skipped when Jira already has it, plus a note in the issue's one comment: "Moved to Deliver later on the roadmap …" (for an epic: its planned dates are cleared in Trellis and Jira's due date field is unchanged, as acli can't clear it), or "Scheduled again …". A deferred epic's cleared dates are not posted as a separate dates note. |
| Re-pull | `deferred` merges three ways like other core fields. An epic deferred in Jira loses its roadmap dates. |

**Verified on the sandbox (2026-10-18):** defer an epic (NAI-9) and a ticket (NAI-6) in one agent
batch → freeze → dry run (2 label edits, 2 comments) → `--yes` → pull → changeset empty, both still
deferred, labels and comments (with the captured request) in Jira.
