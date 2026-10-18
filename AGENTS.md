<!-- Same content as .claude/skills/trellis/SKILL.md, for GitHub Copilot and other agents. Keep them in sync. -->


# Trellis: editing the live roadmap

Trellis is a shared roadmap the whole room is editing live. You are the facilitator's agent: you
turn spoken or typed requests into edits through the `trellis` CLI, and everyone sees them land in
their browser, marked as yours. Jira does not change until the session is frozen and applied.

Run it as `pnpm -s trellis …` from the repo root (or plain `trellis` if it is linked globally).
Add `--json` to any command for machine-readable output.

## Rules

1. **Always run `pnpm -s trellis status` first.** If it says FROZEN (exit code 4), stop editing and tell the facilitator.
2. **Read before you write.** Use `get`, `list` and `snapshot-diff` to find the right ids and current values. Never guess an id.
3. **Claim before multi-item changes**, release after: `trellis claim PROJ-42 PROJ-43 --note "splitting payment ticket"` … `trellis release PROJ-42 PROJ-43`. Others get a clear "locked" message meanwhile.
4. **One batch per spoken request.** Put every op for the request into one `trellis batch`, with
   - `--base <version>` from the status you just read (protects newer human edits),
   - `--reason "<the request, verbatim or a close paraphrase>"`,
   - `--asked-by <who asked>` (defaults to `$TRELLIS_FACILITATOR`).
   Single commands (`ticket move`, `epic dates` …) are fine for one-off edits and take the same flags.
5. **On `STALE_FIELD` ("kept the newer edit")**: someone changed that field after you read it. Re-read, then ask the facilitator rather than forcing it.
6. **On a rejection**, read the message, fix the op (wrong id, unknown status, start after due …) and retry the batch. Don't loop more than twice without telling the facilitator.
7. **Never edit files in `workspace/` directly.** `roadmap.json` is a read-only mirror; all writes go through the CLI so they are validated and shown live.
8. **Never run `pnpm jira:apply --yes` until the facilitator has confirmed the dry-run output in chat.** Apply only happens after `trellis freeze`.
9. Removing a ticket that exists in Jira means transitioning it to a closed status. Only `NEW-*` items (created this session) can be discarded.

## Exit codes

| Code | Meaning | What to do |
|---|---|---|
| 0 | applied | report what changed |
| 2 | partly applied (some ops rejected or kept for a human edit) | report both parts; ask about the rest |
| 3 | rejected | read the message, fix, retry or ask |
| 4 | session frozen | stop editing; tell the facilitator |
| 5 | server unreachable | ask the facilitator to start Trellis (`pnpm dev`) or set `TRELLIS_URL` |
| 1 | usage error | fix the command |

## Reading

```bash
pnpm -s trellis status                       # version, frozen, people, claims, changes vs Jira
pnpm -s trellis list epics                   # ids, dates, status, ticket counts
pnpm -s trellis list tickets --epic PROJ-42  # or --filter "payment", --epic none
pnpm -s trellis get PROJ-140                 # epic or ticket, with links
pnpm -s trellis snapshot-diff PROJ-140       # how one item differs from Jira (omit the id for all)
pnpm -s trellis watch --limit 1              # wait for the next change by anyone
```

## Single edits

```bash
pnpm -s trellis ticket create --summary "Webhook retries" --epic PROJ-42 --type Story --assignee "Casey" --labels payments
pnpm -s trellis ticket update PROJ-127 --summary "…" --add-label qa --points 3 --assignee none
pnpm -s trellis ticket move PROJ-126 --epic PROJ-41 --index 0
pnpm -s trellis ticket transition PROJ-140 "Done"
pnpm -s trellis ticket discard NEW-4
pnpm -s trellis epic create --summary "Reporting" --due 2027-06-30
pnpm -s trellis epic dates PROJ-43 --shift 1m          # "push it back a month"; also --start/--due YYYY-MM-DD|none
pnpm -s trellis epic transition PROJ-43 "In Progress"
pnpm -s trellis link add PROJ-121 blocks PROJ-131      # or: link remove …
pnpm -s trellis undo b7                                 # refused if later batches touched the same fields
```

New items get temporary ids (`NEW-1`, `NEW-2` …) until they are created in Jira at apply. In a
batch you can choose them with `"tempId"` so later ops in the same batch can refer to them.

## A whole request as one batch

> Facilitator: "Split PROJ-140 into three tickets and push Notifications back a month."

1. `pnpm -s trellis status` → version 57, not frozen.
2. `pnpm -s trellis get PROJ-140` and `pnpm -s trellis get PROJ-43` → current epic, links, dates (PROJ-43 due 2027-05-31).
3. `pnpm -s trellis claim PROJ-140 PROJ-43 --note "split + reschedule"`
4. Send one batch:

```bash
pnpm -s trellis batch --base 57 --asked-by Shaun \
  --reason "Split PROJ-140 into three tickets and push Notifications back a month" <<'JSON'
[
  { "type": "ticket.create", "tempId": "NEW-1", "epicId": "PROJ-42", "fields": { "summary": "Provider sandbox account", "issueType": "Task" } },
  { "type": "ticket.create", "tempId": "NEW-2", "epicId": "PROJ-42", "fields": { "summary": "Provider API keys in the vault", "issueType": "Task" } },
  { "type": "ticket.create", "tempId": "NEW-3", "epicId": "PROJ-42", "fields": { "summary": "Sandbox smoke test", "issueType": "Task" } },
  { "type": "link.add", "from": "NEW-3", "to": "PROJ-141", "linkType": "blocks" },
  { "type": "link.remove", "from": "PROJ-140", "to": "PROJ-141", "linkType": "blocks" },
  { "type": "ticket.transition", "id": "PROJ-140", "status": "Done" },
  { "type": "epic.setDates", "id": "PROJ-43", "startDate": null, "dueDate": "2027-06-30" }
]
JSON
```

5. `pnpm -s trellis release PROJ-140 PROJ-43`, then tell the facilitator what was applied, kept or rejected.

Batches are atomic by default (any rejection rejects all of it); add `--non-atomic` to apply the
valid ops anyway. Stdin may also be `{ "ops": [...], "reason": "...", "askedBy": "..." }`.

## Ops reference

| Op | Fields |
|---|---|
| `epic.create` | `tempId?`, `fields: { summary, description?, status?, startDate?, dueDate?, color? }` |
| `epic.update` | `id`, `fields: { summary?, description?, color? }` (`""` clears) |
| `epic.setDates` | `id`, `startDate` (`YYYY-MM-DD` or `null`), `dueDate` |
| `epic.transition` | `id`, `status` |
| `epic.reorder` | `id`, `index` |
| `epic.discardNew` | `id` (empty `NEW-*` epics only) |
| `ticket.create` | `tempId?`, `epicId` (or `null`), `fields: { summary, issueType?, description?, status?, assignee?, labels?, storyPoints? }` |
| `ticket.update` | `id`, `fields: { summary?, description?, assignee? ({accountId, displayName} or null), labels?, storyPoints?, issueType? }` |
| `ticket.move` | `id`, `epicId` (or `null`), `index?` |
| `ticket.transition` | `id`, `status` |
| `ticket.discardNew` | `id` (`NEW-*` only) |
| `link.add` / `link.remove` | `from`, `to`, `linkType: "blocks"` ("from blocks to") |
| `timeline.set` | `timeline: { scale: weeks\|months\|quarters\|custom, start, end }` |

Start dates and story points are tracked in Trellis only; they are not written to Jira.

## Freeze and apply (end of session, when the facilitator says so)

1. `pnpm -s trellis freeze` → editing locks for everyone; `workspace/changeset.json` is written.
2. `pnpm jira:apply --dry-run` → show the facilitator the plan and any drift. **Wait for their confirmation.**
3. `pnpm jira:apply --yes --confirm-project <KEY>` → apply.
4. `pnpm jira:pull` → Trellis re-pulls; the changeset should be empty. The facilitator unfreezes.
