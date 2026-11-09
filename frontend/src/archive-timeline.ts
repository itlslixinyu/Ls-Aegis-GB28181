export interface ArchiveSegment {
  id: string;
  name: string;
  url: string;
  start: number;
  end: number;
}

// ZLMediaKit filenames use the recording node's civil time (Asia/Shanghai).
// Do not infer coverage from configured segment length or the next filename.
export function archiveStart(name: string, date: string): number | null {
  const value = name.startsWith(date + "-") ? name.slice(11) : name;
  const match = /^(\d{2})-(\d{2})-(\d{2})(?:[-_.]|$)/.exec(value);
  if (!match) return null;
  const [, h, m, s] = match.map(Number);
  return h < 24 && m < 60 && s < 60 ? h * 3600 + m * 60 + s : null;
}

export function segmentAt(
  segments: ArchiveSegment[],
  second: number,
  skipGaps: boolean,
) {
  const covering = segments.filter((s) => s.start <= second && second < s.end);
  if (covering.length) return covering.sort((a, b) => b.start - a.start)[0];
  return skipGaps ? segments.find((s) => s.start > second) : undefined;
}

export function followingSegment(
  segments: ArchiveSegment[],
  current: ArchiveSegment,
) {
  return segments.find(
    (s) =>
      s.id !== current.id &&
      s.end > current.end + 0.25 &&
      s.start >= current.start,
  );
}

export function clockTime(second: number) {
  const value = Math.max(0, Math.min(86400, Math.floor(second)));
  return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}
