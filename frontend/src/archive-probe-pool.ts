// Metadata reads share the same origin as live video. Bound them across windows.
type Waiting = {
  signal: AbortSignal;
  grant: (release: (() => void) | null) => void;
  abort: () => void;
};
const waiting: Waiting[] = [];
let active = 0;
function pump() {
  while (active < 4 && waiting.length) {
    const job = waiting.shift()!;
    job.signal.removeEventListener("abort", job.abort);
    if (job.signal.aborted) {
      job.grant(null);
      continue;
    }
    active++;
    let released = false;
    job.grant(() => {
      if (released) return;
      released = true;
      active--;
      pump();
    });
  }
}
export function acquireArchiveProbe(
  signal: AbortSignal,
): Promise<(() => void) | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((grant) => {
    const job: Waiting = {
      signal,
      grant,
      abort: () => {
        const index = waiting.indexOf(job);
        if (index >= 0) {
          waiting.splice(index, 1);
          grant(null);
        }
      },
    };
    signal.addEventListener("abort", job.abort, { once: true });
    waiting.push(job);
    pump();
  });
}
