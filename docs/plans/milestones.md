# Trellis change plan: Milestones scale and Deliver later

_Status: in progress (M0 approved) · 18 Oct 2026_

## Why

The current project has features that must land by **9 Nov 2026**, and others that will be pushed
to later. Weeks, months and quarters don't show that: the room needs to see what's in, what's out,
and whether the in-scope work fits before the date.

This plan changes Trellis as built. `docs/PLAN.md` stays the main spec, and this change updates it
in its last phase. Where this plan conflicts with the code or `docs/jira-mapping.md`, list the
conflicts for the facilitator before building (done: see "M0 decisions" at the end).

References:
- `docs/design/` screens 1–4, updated for this change (screen 1 is the main one);
- `docs/brief.md`: the Key decisions, Design screens and Visual language sections.

## Scope

**In**
- a Milestones scale
- the Deliver later tray
- deferring epics and single tickets
- a scope summary
- milestone and deferral warnings
- CLI commands
- deferral reaching Jira

**Out (v1)**
- milestones in Jira (they live in `roadmap.json` only)
- several trays
- capacity or points-per-week maths

## What the user sees (match `docs/design/` screen 1)

**Timeline and tray**
- **Scale select:** Milestones becomes the first option and the default for new sessions.
- **Milestones scale:** one column per week (w/c Monday) from the timeline start to the last
  milestone.
  - The current week is tinted `#FAF1E7`.
  - Each milestone is a 3 px ochre (`#C9963A`) line at its date, with an ochre tag in the header
    ("9 Nov").
  - Milestone lines also show in the other scales.
- **Deliver later tray:** a column after the last milestone.
  - It sits after a 20 px gutter, with a hatched background (`#F6EADF` / `#FBF3EA` stripes at
    135°) and a tray icon in its header. It has no dates and isn't to scale.
  - Epics in the tray render as compact bars with a tray icon.
  - A ticket deferred on its own shows as a card in the tray, on its epic's row, while the epic
    stays scheduled.
  - Dragging a bar or card into the tray defers it. Dragging it out undefers it and sets dates
    from where it lands.
  - Keyboard: a "Move to Deliver later" / "Schedule" action on bars and cards.

**Toolbar**
- a milestone chip ("Delivery · 9 Nov") that opens an edit popover for the label and date;
- "+ Milestone" and a "Show Deliver later" checkbox;
- a scope summary: "By 9 Nov: 3 epics · 23 tickets" and "Later: 2 epics · 15 tickets". A ticket
  counts as later if it or its epic is deferred.

**Elsewhere**
- **Warnings:**
  - an epic whose due date falls after the milestone it sits before;
  - an in-scope ticket blocked by a deferred one;
  - a dependency with no slack before a milestone.
- **Ticket detail:** deferred tickets carry a "Deliver later" tag with the tray icon.
- **Changes view and Freeze screen:** a new **Defer** operation type, styled `#EFE3D6` /
  `#464A3B`.
- **Accessibility:** colour is never the only signal; every deferred item has the tray icon or the
  label.

## Data model and operations

```ts
interface Milestone { id: string; label: string; date: string }   // date: work lands on or before

interface TimelineConfig {
  scale: 'milestones' | 'weeks' | 'months' | 'quarters' | 'custom';  // default 'milestones'
  start: string;
  end: string;                        // milestones scale ends at the last milestone instead
  customRanges?: { label: string; start: string; end: string }[];
  milestones: Milestone[];            // sorted by date; may be empty
  showLater: boolean;                 // default true
  laterLabel: string;                 // default "Deliver later" (display text only)
}

// Epic:   deferred: boolean   (true clears its dates in Trellis)
// Ticket: deferred: boolean   (deferred on its own while its epic stays scheduled)

type Op = /* existing ops */
  | { type: 'epic.defer';   id: IssueId; deferred: boolean }
  | { type: 'ticket.defer'; id: IssueId; deferred: boolean };
```

- Milestones are edited through the existing `timeline.set`.
- Rules:
  - a deferred epic can't take `epic.setDates` without first being undeferred (one batch can do
    both);
  - deferring an epic leaves its tickets' own flags alone.
- The new ops go through validation, the conflict check, undo, the oplog and broadcast, like every
  other op.
- Changeset order: defer/undefer goes after transitions and before epic dates.
- `roadmap.json` and `state.json` load older files without these fields, using the defaults.

## CLI

```
trellis epic defer|undefer <id>
trellis ticket defer|undefer <id>
trellis milestone list | add <label> <date> | set <id> <date> | remove <id>
trellis scope [--milestone ID] [--json]      # in vs later counts and lists
```

Add to the agent skill and `AGENTS.md`: "Notifications won't make 9 Nov, put it in deliver later"
becomes one batch with `--reason` and `--asked-by`.

## Jira

Deferral follows how date changes work today: dates are owned by Trellis, and changes reach Jira as
comments.

- Defer or undefer posts one comment on the issue, including the captured request when there is
  one. It joins the existing one-comment-per-changed-issue rule rather than adding a second
  comment.
- The Atlassian CLI can set labels (`workitem edit --labels / --remove-labels`,
  `workitem create --label`), so apply also adds or removes the `deliver-later` label. On pull,
  that label is read as `deferred`.

## Phases

Stop for review after each phase. Each one ends with `pnpm typecheck`, `pnpm lint` and
`pnpm test` passing.

**M0 · Check (read-only)** ✅ approved 18 Oct 2026
- Read the code, `docs/PLAN.md` and `docs/jira-mapping.md`.
- Confirm whether the Atlassian CLI can set labels.
- List conflicts with this plan and a file-by-file change list.

**M1 · Model** ✅ done 18 Oct 2026
- Types, zod schemas, the two defer ops, the timeline config, the reducer, validation and undo.
- Scope summary and warning helpers in `@trellis/shared`.
- Changeset ordering.
- Loading old files.
- ✅ Done when unit tests cover defer and undefer, the cleared epic dates, scope counts and
  ordering.

**M2 · Server and CLI** ✅ done 18 Oct 2026
- The ops end to end through the server.
- The new CLI commands with `--json` and exit codes.
- Skill and `AGENTS.md` updates.
- ✅ Done when one CLI batch can defer an epic and add a milestone, and a browser sees both live.

**M3 · Web** ✅ done 18 Oct 2026
- The Milestones scale, the tray, drag in and out, keyboard actions, toolbar chips and popover.
- The scope summary, warnings, ticket tags and the Defer op styling.
- ✅ Done when it matches `docs/design/` and a two-browser test passes (one person drags an epic
  into the tray, the other sees it).

**M4 · Jira**
- Defer and undefer comments, labels, label read on pull.
- ✅ Done when the full loop on the sandbox project (defer, freeze, dry run, apply, re-pull) leaves
  an empty changeset with deferral preserved. Show the dry run before any `--yes`.

**M5 · Docs**
- Fold this change into `docs/PLAN.md`: data model, ops, CLI, Jira mapping, the §9 screen 1
  description, §10 tokens.
- Update `docs/jira-mapping.md` and `docs/brief.md`.
- Mark this plan "Done".
- ✅ Done when no doc still describes the old default scale.

## M0 decisions (approved by the facilitator)

1. **Custom scale kept.** `milestones` is added as the first option; `custom` stays.
2. **`end` stays required.** The milestones scale ends at the last milestone and falls back to
   `end` when there are none.
3. **The Jira label is hidden.** Pull strips `deliver-later` from labels and sets `deferred`
   (epics too); apply adds or removes it in the defer step. Label drift checks ignore it.
4. **No label config.** A constant `LATER_LABEL = 'deliver-later'` in `packages/jira`; no
   `config.json` (`docs/jira-mapping.md` says it isn't needed) and no env var.
5. **Deferral is a core field**, diffed against the snapshot and merged three ways on re-pull, not
   Trellis-owned like dates.
6. **A deferred epic's cleared dates stay out of the changeset.** The defer note says the planned
   dates were cleared; Jira's due date field is left alone (acli can't clear it).
7. **Warnings use epic dates**, as tickets have none (like the existing backwards-dependency check).
8. **Milestone line** sits at the start of the milestone day, as in the design; an epic makes it
   when `dueDate <= milestone.date`.
9. **Ochre means milestone** in the milestones scale; the current week gets the `#FAF1E7` tint
   instead of the ochre now marker.
10. Semantics:
    - `epic.defer true` clears dates; its undo restores them. Deferring twice is a no-op.
    - `epic.setDates` on a deferred epic is rejected with `DEFERRED`.
    - Scope per milestone M: later = deferred (a ticket also when its epic is); by M = scheduled
      epics due on or before M and their tickets that aren't later; the rest is "after / not placed".
    - Warnings: `pastMilestone` (due after the first milestone on or after its start),
      `blockedByLater`, `noSlack` (blocker's epic due in the last 7 days before the milestone).
