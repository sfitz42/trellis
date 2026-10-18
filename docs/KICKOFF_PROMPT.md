# Kickoff prompt for Claude Code

Put the plan at `docs/PLAN.md` in an empty repo. Export the Trellis project brief (the live doc
linked from `docs/PLAN.md`) as Markdown to `docs/brief.md`, and the four screens from the design
canvas as PNGs into `docs/design/`. Create a `.env` in the repo root (it is gitignored):

```bash
JIRA_SITE=your-site.atlassian.net
JIRA_PROJECT_KEY=PROJ   # a sandbox project while you are testing
```

Then open Claude Code there, switch to plan mode, and paste the prompt below.

---

We're building Trellis, the app described in `docs/PLAN.md`. Read `docs/brief.md` first for the why
and the decisions behind it, then read `docs/PLAN.md` fully, and look at the screen images in
`docs/design/`. If the brief and the plan disagree anywhere, list the conflicts for me rather than
choosing.

Today, do **Phase 0 only: Jira discovery. It is strictly read-only.** Do not create, edit,
transition, link or comment on anything in Jira.

Our Jira details are in `.env` as `JIRA_SITE` and `JIRA_PROJECT_KEY` (Cloud). Read them from there;
don't hard-code them anywhere or repeat them into committed files. If either is missing, stop and
tell me.

1. Scaffold the bare **pnpm monorepo** exactly as docs/PLAN.md §2 describes: pnpm pinned with
   `packageManager`, `pnpm-workspace.yaml`, `.npmrc` with `ignore-scripts=true`, a strict
   `tsconfig.base.json` plus solution `tsconfig.json`, `.gitignore` (including `.env` and
   `workspace/*`), `.dockerignore`, and empty `@trellis/*` packages under `apps/` and `packages/`
   that pass `pnpm typecheck`. Don't write the Dockerfile or `compose.yaml` yet (Phase 6). Add
   `.env.example` with the variable names and placeholder values. Discovery helpers go in
   `packages/jira/src/discovery/`, in TypeScript, run with `tsx`. Use pnpm only, and if a
   dependency won't work without its install script, stop and ask.
2. Load my Atlassian CLI skill and confirm `acli` is installed and authenticated for `JIRA_SITE`. If
   it isn't, stop and tell me what to run.
3. Explore the `JIRA_PROJECT_KEY` project with the CLI:
   - issue types in use, and how epics relate to their child tickets (`parent` or otherwise)
   - every epic with its status, start date, due date and child count
   - the custom field ids for **Start date** and **Story points**
   - workflows: statuses and available transitions for Epic, Story, Task and Bug
   - link types, specifically the one for "blocks / is blocked by"
   - assignable users (count and shape of the data only)
   - rough volume: number of epics, number of open tickets
4. For each `JiraAdapter` method in docs/PLAN.md §7, find the exact `acli` command that would do it and
   whether it supports JSON output. Don't run any write commands; check their help text instead.
   List any capability the CLI is missing.
5. Write `docs/jira-mapping.md` covering the above: field ids, commands, gaps and anything in
   docs/PLAN.md that doesn't fit our Jira setup. Refer to the project as `$JIRA_PROJECT_KEY`, not by its
   real key.
6. Write a **sanitised** fixture at `packages/shared/fixtures/snapshot.sample.json`, shaped like
   docs/PLAN.md §3's `snapshot.json`, with the same structure as the real project. Use a fake site,
   project key, summaries, names and account ids, and around 5 epics and 30–40 tickets.
7. Stop and give me a short summary: what you found, the CLI gaps, and any changes you'd suggest
   to docs/PLAN.md before Phase 1.

Ask me before installing anything. Keep real Jira data out of the repo: only the sanitised fixture,
`.env.example` and the mapping doc get committed.

---

### Prompts for later phases

When a phase is reviewed, start the next one with:

> Continue with **Phase N** from `docs/PLAN.md`. Re-read §13–14, `docs/brief.md` and
> `docs/jira-mapping.md` first. Plan the work, show me the plan, then implement with tests. Stop at
> the end of the phase with a summary and how to try it.

For Phase 5, add:

> `JIRA_PROJECT_KEY` points at the sandbox project, so every write goes there. Run `jira:apply` as a
> dry run and show me the output before any run with `--yes --confirm-project <KEY>`.
