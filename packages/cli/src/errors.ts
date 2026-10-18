// Exit codes (PLAN.md §8): 0 ok, 2 partially applied, 3 rejected, 4 frozen, 5 server unreachable.
// 1 is for usage errors (bad flags, bad input).
import type { BatchResult } from '@trellis/shared';

export const EXIT = { ok: 0, usage: 1, partial: 2, rejected: 3, frozen: 4, unreachable: 5 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  constructor(readonly exitCode: ExitCode, message: string, readonly details?: unknown) {
    super(message);
  }
}

export function exitForBatch(r: BatchResult): ExitCode {
  if (r.rejected.some((x) => x.code === 'FROZEN')) return EXIT.frozen;
  const rejected = r.rejected.length > 0;
  const skipped = r.skipped.length > 0;
  if (r.applied.length === 0) return rejected || skipped ? EXIT.rejected : EXIT.ok;
  return rejected || skipped ? EXIT.partial : EXIT.ok;
}
