// Timeline maths (PLAN.md §3, §9). Columns are display only: epics store real dates, the scale
// just decides how they are drawn and what a drag snaps to. All dates are ISO YYYY-MM-DD (UTC).
import type { TimelineConfig } from '@trellis/shared';

export type Scale = TimelineConfig['scale'];
export type UnitScale = 'weeks' | 'months' | 'quarters';

export interface Column {
  start: string;
  /** Last day of the column (inclusive). */
  end: string;
  label: string;
  sublabel: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parse(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}
export function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
export function addDays(date: string, n: number): string {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
export function daysBetween(a: string, b: string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);
}
function addMonthsClamped(date: string, n: number): string {
  const d = parse(date);
  const day = d.getUTCDate();
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(day, last));
  return iso(first);
}

/** First day of the unit containing `date`. Weeks start on Monday. */
export function unitStart(date: string, scale: UnitScale): string {
  const d = parse(date);
  if (scale === 'weeks') return addDays(date, -((d.getUTCDay() + 6) % 7));
  const month = scale === 'quarters' ? d.getUTCMonth() - (d.getUTCMonth() % 3) : d.getUTCMonth();
  return iso(new Date(Date.UTC(d.getUTCFullYear(), month, 1)));
}

/** Last day of the unit containing `date`. */
export function unitEnd(date: string, scale: UnitScale): string {
  return addDays(shift(unitStart(date, scale), 1, scale), -1);
}

/** Move a date by `n` units. Month-based units keep the day where possible. */
export function shift(date: string, n: number, scale: UnitScale): string {
  if (scale === 'weeks') return addDays(date, 7 * n);
  return addMonthsClamped(date, scale === 'quarters' ? 3 * n : n);
}

/** Effective unit for a scale (custom ranges move and snap by month; milestones by week). */
export function unitOf(scale: Scale): UnitScale {
  if (scale === 'custom') return 'months';
  if (scale === 'milestones') return 'weeks';
  return scale;
}

/**
 * Last day shown. The milestones scale ends where the last milestone's line is drawn: at the start
 * of its day, so the day before (docs/plans/milestones.md, M0 decision 8).
 */
export function lastDay(t: Pick<TimelineConfig, 'scale' | 'end' | 'milestones'>): string {
  const last = t.milestones.at(-1);
  return t.scale === 'milestones' && last ? addDays(last.date, -1) : t.end;
}

export function columns(t: TimelineConfig): Column[] {
  if (t.scale === 'custom' && t.customRanges && t.customRanges.length > 0) {
    return t.customRanges.map((r) => ({ start: r.start, end: r.end, label: r.label, sublabel: `${fmtShort(r.start)} – ${fmtShort(r.end)}` }));
  }
  const unit = unitOf(t.scale);
  const end = lastDay(t);
  const out: Column[] = [];
  for (let start = unitStart(t.start, unit); start <= end && out.length < 400; start = shift(start, 1, unit)) {
    const d = parse(start);
    const year = String(d.getUTCFullYear());
    const end = unitEnd(start, unit);
    if (unit === 'months') out.push({ start, end, label: MONTHS[d.getUTCMonth()] ?? '', sublabel: year });
    else if (unit === 'quarters') out.push({ start, end, label: `Q${Math.floor(d.getUTCMonth() / 3) + 1}`, sublabel: year });
    else out.push({ start, end, label: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()] ?? ''}`, sublabel: `w/c · ${year}` });
  }
  return out;
}

/** Position of the *start* of `date` in column units (0 = left edge of the first column). */
export function position(date: string, cols: readonly Column[]): number {
  if (cols.length === 0) return 0;
  const first = cols[0] as Column;
  const last = cols[cols.length - 1] as Column;
  if (date < first.start) {
    const span = daysBetween(first.start, first.end) + 1;
    return daysBetween(first.start, date) / span;
  }
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i] as Column;
    if (date <= c.end) return i + Math.max(0, daysBetween(c.start, date)) / (daysBetween(c.start, c.end) + 1);
  }
  return cols.length + daysBetween(addDays(last.end, 1), date) / (daysBetween(last.start, last.end) + 1);
}

/** Position of the *end* of `date` (the day included), so a bar ending on the 31st fills the month. */
export function endPosition(date: string, cols: readonly Column[]): number {
  return position(addDays(date, 1), cols);
}

/** The column index containing `date`, or -1. */
export function columnIndex(date: string, cols: readonly Column[]): number {
  return cols.findIndex((c) => c.start <= date && date <= c.end);
}

export interface Span {
  startDate: string | null;
  dueDate: string | null;
}

/** How a bar for these dates is drawn: left/width in column units, and which ends are real. */
/**
 * Where to draw an epic that has no start date (common: Jira has none; it's Trellis-owned).
 * With `today`: from the current unit to the due date ("in flight until due"); without, or if the
 * due date is already past: one unit ending at the due date.
 */
export function implicitStart(due: string, scale: Scale, today?: string): string {
  const unit = unitOf(scale);
  const own = unitStart(due, unit);
  if (!today) return own;
  const now = unitStart(today, unit);
  return now < own ? now : own;
}

export function barGeometry(span: Span, cols: readonly Column[], scale: Scale, today?: string): { left: number; width: number; hasStart: boolean; hasDue: boolean } | null {
  if (span.dueDate === null && span.startDate === null) return null;
  const unit = unitOf(scale);
  const due = span.dueDate ?? unitEnd(span.startDate as string, unit);
  const start = span.startDate ?? implicitStart(due, scale, today);
  const left = position(start, cols);
  return { left, width: Math.max(endPosition(due, cols) - left, 0.15), hasStart: span.startDate !== null, hasDue: span.dueDate !== null };
}

export type DragMode = 'move' | 'start' | 'end';

/**
 * New dates after dragging a bar by `units` scale units (whole units only: drags snap).
 * `move` shifts both ends; `start`/`end` resize one end and never cross the other.
 */
export function dragDates(span: Span, mode: DragMode, units: number, scale: Scale, today?: string): Span {
  const unit = unitOf(scale);
  const geo = { start: span.startDate, due: span.dueDate };
  const baseDue = geo.due ?? (geo.start ? unitEnd(geo.start, unit) : null);
  // Dragging an epic without a start date gives it one, from where it is drawn.
  const baseStart = geo.start ?? (baseDue ? implicitStart(baseDue, scale, today) : null);
  if (baseStart === null || baseDue === null) return span;
  if (mode === 'move') {
    return { startDate: unitStart(shift(baseStart, units, unit), unit), dueDate: unitEnd(shift(baseDue, units, unit), unit) };
  }
  if (mode === 'start') {
    const start = unitStart(shift(baseStart, units, unit), unit);
    return { startDate: start > baseDue ? unitStart(baseDue, unit) : start, dueDate: baseDue };
  }
  const due = unitEnd(shift(baseDue, units, unit), unit);
  return { startDate: baseStart, dueDate: due < baseStart ? unitEnd(baseStart, unit) : due };
}

/** Timeline that starts at `start`'s unit and shows `count` units. */
export function timelineFrom(start: string, scale: Scale, count: number, prev?: TimelineConfig): TimelineConfig {
  const unit = unitOf(scale);
  const s = unitStart(start, unit);
  const t: TimelineConfig = {
    scale, start: s, end: unitEnd(shift(s, count - 1, unit), unit),
    milestones: prev?.milestones ?? [], showLater: prev?.showLater ?? true, laterLabel: prev?.laterLabel ?? 'Deliver later',
  };
  if (prev?.customRanges) t.customRanges = prev.customRanges;
  return t;
}

export function fmtShort(date: string): string {
  const d = parse(date);
  return `${MONTHS[d.getUTCMonth()] ?? ''} ${String(d.getUTCFullYear()).slice(2)}`;
}

/** "Nov 2026 → Mar 2027" style range for headers. */
export function fmtRange(span: Span): string {
  const f = (d: string | null): string => (d ? `${MONTHS[parse(d).getUTCMonth()] ?? ''} ${parse(d).getUTCFullYear()}` : '—');
  return `${f(span.startDate)} → ${f(span.dueDate)}`;
}

export function fmtMonth(date: string | null): string {
  return date ? (MONTHS[parse(date).getUTCMonth()] ?? '') : '—';
}
