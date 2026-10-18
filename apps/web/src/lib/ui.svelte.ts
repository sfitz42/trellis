// Local (per-browser) UI state: which view, what's selected, what's expanded.
import type { IssueId } from '@trellis/shared';

export type View = 'timeline' | 'changes' | 'activity';

class Ui {
  view = $state<View>('timeline');
  /** Ticket open in the detail panel (screen 2). */
  ticket = $state<IssueId | null>(null);
  /** Epic shown in the focus view (screen 2, left side). */
  epic = $state<IssueId | null>(null);
  expanded = $state<IssueId[]>([]);
  filter = $state('');
  agentPanel = $state(false);
  create = $state<null | { kind: 'ticket' | 'epic'; epicId?: IssueId | null }>(null);

  toggle(id: IssueId): void {
    this.expanded = this.expanded.includes(id) ? this.expanded.filter((x) => x !== id) : [...this.expanded, id];
  }

  openTicket(id: IssueId, epicId: IssueId | null): void {
    this.ticket = id;
    this.epic = epicId;
    this.agentPanel = false;
  }

  closeDetail(): void {
    this.ticket = null;
    this.epic = null;
  }
}

export const ui = new Ui();
