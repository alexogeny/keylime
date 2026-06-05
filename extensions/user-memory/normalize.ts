export function uniqueCleanTags(tags: Array<string | undefined> | undefined): string[] {
  return [...new Set((tags ?? [])
    .filter((tag): tag is string => typeof tag === "string")
    .map(tag => tag.trim().replace(/^#/, "").toLowerCase())
    .filter(Boolean))];
}

export function parseCommaList(input: string | undefined): string[] {
  return uniqueCleanTags(input?.split(","));
}
