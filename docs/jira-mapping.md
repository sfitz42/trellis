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
| `labels` | `fields.labels` | |
| `links` | `fields.issuelinks[]`: `type.name`, `outwardIssue.key` or `inwardIssue.key`, `id` | Keep the link `id`: delete needs it. |
| Epic `dueDate` | `fields.duedate` | System field. Can be set on create (verified), but **can't be edited** (see gaps). |

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
| Link types | Blocks, Cloners, Duplicate, Relates. Use the **name** `Blocks`: `link create --type Blocks --out A --in B` means "A blocks B". |
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
| `addLink(from, to, 'blocks')` | `acli jira workitem link create --out <from> --in <to> --type Blocks --yes` | no | Verified. Output is a single text line. |
| `removeLink(...)` | `acli jira workitem link delete --id <linkId> --yes` | no | Help only (a test delete was blocked by Claude Code's auto mode). Needs the link **id**, from `issuelinks[].id` or `acli jira workitem link list --key <key> --json`. |
| `addComment(key, body)` | `acli jira workitem comment create --key <key> --body "<text or ADF>" --json` | yes | Help only. |
| `listTransitions(key)` | — | — | **Missing.** |
| `listAssignableUsers(project)` | — | — | **Missing.** |
| (project info) | `acli jira project view --key <key> --json` | yes | Verified: issue types with hierarchy levels and project style. |
| (link types) | `acli jira workitem link type --json` | yes | Verified: names only. |
| (auth check) | `acli jira auth status` | no | Verified. Plain text that includes `Site: <site>`. |

## CLI gaps (to be decided; no fallback to raw REST has been made)

1. **`edit` can't change due date, parent or custom fields.** The plan's `epic.setDates` (due-date
   part) and `ticket.move` (change of epic) can't be applied to issues that already exist. This is
   the most important gap. Options: (a) Jira REST for just these two fields, (b) apply them by
   hand from a checklist the apply step prints, (c) a newer `acli` if one adds it.
2. **No way to list transitions.** The UI can't know which statuses are reachable. Workaround:
   offer the statuses seen per type, and let apply report a rejected transition as a failed step.
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
- §3 `Link` only models `blocks`. Jira links have a type and a direction; consider keeping any link
  type (`{ type: string; direction: 'outward' | 'inward'; target; jiraLinkId? }`) and only *editing*
  Blocks in v1.
- §3 `snapshot.workflow`: transitions can't be listed (gap 2), so it holds statuses per type with
  categories plus the people seen, and `transitions: null`.
- §6/§7 `epic.setDates` and `ticket.move` are blocked by gap 1 for existing issues.
- §7 `packages/jira/config.json` isn't needed: nothing project-specific is hard-coded.

## Discovery scripts

| Command | What it does |
|---|---|
| `pnpm jira:auth` | Checks that `acli` is installed and logged in to `JIRA_SITE`. |
| `pnpm jira:discover` | Read-only exploration (through a guard that only allows read commands); prints counts, types, statuses and shapes. |
| `pnpm jira:help-audit` | Saves `--help` text for every relevant command. |
| `pnpm jira:fixture` | Regenerates `packages/shared/fixtures/snapshot.sample.json` (all data invented). |
| `seed-sandbox.ts` | One-off writes, approved for the sandbox: seeds an **empty** project; requires `--confirm-project`. |
