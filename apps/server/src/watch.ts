// Watch workspace files written by the Jira scripts (snapshot.json, apply-log.json).
// fs.watch on the directory catches atomic replace-by-rename; polling is the fallback for bind
// mounts that don't deliver events (WATCH_POLL=1).
import { watch, watchFile, unwatchFile } from 'node:fs';
import { join } from 'node:path';

export function watchWorkspace(
  dir: string,
  names: readonly string[],
  onChange: (name: string) => void,
  opts: { poll: boolean; debounceMs?: number; pollIntervalMs?: number },
): () => void {
  const timers = new Map<string, NodeJS.Timeout>();
  const fire = (name: string): void => {
    clearTimeout(timers.get(name));
    timers.set(name, setTimeout(() => {
      timers.delete(name);
      onChange(name);
    }, opts.debounceMs ?? 150));
  };

  if (opts.poll) {
    const paths = names.map((n) => join(dir, n));
    paths.forEach((p, i) => {
      watchFile(p, { interval: opts.pollIntervalMs ?? 500 }, (curr, prev) => {
        if (curr.mtimeMs !== prev.mtimeMs) fire(names[i] ?? '');
      });
    });
    return () => {
      paths.forEach((p) => { unwatchFile(p); });
      timers.forEach((t) => { clearTimeout(t); });
    };
  }

  const watcher = watch(dir, (_event, filename) => {
    if (filename && names.includes(filename)) fire(filename);
  });
  return () => {
    watcher.close();
    timers.forEach((t) => { clearTimeout(t); });
  };
}
