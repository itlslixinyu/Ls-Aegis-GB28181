export interface RecordSearchRange {
  start: string;
  end: string;
  date: string;
  from: number;
  to: number;
  key: string;
}
export function recordSearchRange(
  start: string,
  end: string,
): RecordSearchRange {
  function parse(value: string) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return NaN;
    const normalized = value.length === 16 ? value + ":00" : value;
    const time = Date.parse(normalized + "+08:00");
    return Number.isFinite(time) &&
      new Date(time + 8 * 3600000).toISOString().slice(0, 19) === normalized
      ? time
      : NaN;
  }
  const from = parse(start),
    to = parse(end);
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    to <= from ||
    to - from > 86400000
  )
    throw Error("请设置开始早于结束、跨度不超过24小时的有效时间范围");
  const date = start.slice(0, 10),
    midnight = Date.parse(date + "T00:00:00+08:00");
  const first = new Date(from).toISOString(),
    last = new Date(to).toISOString();
  return {
    start: first,
    end: last,
    date,
    from: (from - midnight) / 1000,
    to: (to - midnight) / 1000,
    key: first + "/" + last,
  };
}
export function defaultRecordRange(
  date = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }),
) {
  const next = new Date(
    Date.parse(date + "T00:00:00+08:00") + 86400000,
  ).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
  return { start: date + "T00:00:00", end: next + "T00:00:00" };
}
