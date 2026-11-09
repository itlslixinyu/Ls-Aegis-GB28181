export const MOTION_VERSION = "gray96x54-fps1-v1";
export const WIDTH = 96,
  HEIGHT = 54;
// Mean compensation suppresses uniform lighting changes. This is a motion cue,
// not an object detector; periodic frames remain mandatory.
export function motionChanges(raw, start, { fps = 1, maxEvents = 6 } = {}) {
  const bytes = WIDTH * HEIGHT,
    count = Math.floor(raw.length / bytes),
    events = [];
  for (let n = 1; n < count; n++) {
    const a = raw.subarray((n - 1) * bytes, n * bytes),
      b = raw.subarray(n * bytes, (n + 1) * bytes);
    let mean = 0;
    for (let i = 0; i < bytes; i++) mean += b[i] - a[i];
    mean /= bytes;
    let changed = 0,
      minX = WIDTH,
      minY = HEIGHT,
      maxX = 0,
      maxY = 0;
    for (let i = 0; i < bytes; i++)
      if (Math.abs(b[i] - a[i] - mean) > 22) {
        changed++;
        const x = i % WIDTH,
          y = Math.floor(i / WIDTH);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    const fraction = changed / bytes;
    if (changed < 12 || fraction < 0.003) continue;
    const offset = start + n / fps;
    if (events.length && offset - events.at(-1).offset < 3) {
      if (fraction <= events.at(-1).score) continue;
      events.pop();
    }
    events.push({
      offset,
      score: fraction,
      region: {
        x: Math.max(0, (minX - 5) / WIDTH),
        y: Math.max(0, (minY - 5) / HEIGHT),
        right: Math.min(1, (maxX + 6) / WIDTH),
        bottom: Math.min(1, (maxY + 6) / HEIGHT),
      },
    });
  }
  return events
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEvents)
    .sort((a, b) => a.offset - b.offset);
}
export function periodicOffsets(begin, end, interval = 30, max = 6) {
  if (end <= begin) return [];
  const count = Math.ceil((end - begin) / interval) + 1;
  if (count > max)
    return Array.from(
      { length: max },
      (_, i) =>
        Math.round((begin + ((end - begin - 1) * i) / (max - 1)) * 100) / 100,
    );
  const offsets = [];
  for (let at = begin; at < end; at += interval) offsets.push(at);
  if (end - begin > 2) offsets.push(Math.max(begin, end - 1));
  return [...new Set(offsets.map((x) => Math.round(x * 100) / 100))].slice(
    0,
    max,
  );
}
