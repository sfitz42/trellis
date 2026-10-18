# workspace/

Runtime files for the live Trellis session. **Do not edit them by hand.**

| File | Written by | Notes |
|---|---|---|
| `snapshot.json` | `pnpm jira:pull` | what Jira says |
| `roadmap.json` | the server | read-only mirror of the live roadmap |
| `state.json`, `oplog.jsonl` | the server | restore file and batch log |
| `changeset.json`, `.lock` | the server, on freeze | what apply will do |
| `apply-plan.json`, `apply-log.json` | `pnpm jira:apply` | dry-run plan and progress |

Agents change the roadmap only through the `trellis` CLI (see `AGENTS.md` at the repo root).
Everything here except this file is gitignored: it may contain real Jira data.
