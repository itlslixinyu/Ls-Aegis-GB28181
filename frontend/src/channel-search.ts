export function matchesChannelSearch(
  query: string,
  values: readonly unknown[],
): boolean {
  const normalize = (value: string) =>
    value.normalize("NFKC").toLocaleLowerCase();
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const text = values
    .filter((value) => value != null)
    .map((value) => normalize(String(value)))
    .join(" ");
  return terms.every((term) => text.includes(term));
}
