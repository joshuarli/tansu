const DATE_ONLY_PATTERN = /^(\d{4}-\d{2}-\d{2})$/u;

export function formatPublishedDate(published: string): string {
  const dateOnly = getValidDateOnly(published),
    publishedDate = dateOnly ? new Date(`${dateOnly}T00:00:00Z`) : new Date(published);
  if (Number.isNaN(publishedDate.getTime())) return "";
  return publishedDate.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    ...(dateOnly ? { timeZone: "UTC" } : {}),
  });
}

export function formatFrontmatterDate(published: string): string {
  const dateOnly = getValidDateOnly(published);
  if (dateOnly) return dateOnly;

  const publishedDate = new Date(published);
  if (Number.isNaN(publishedDate.getTime())) return published;

  const year = publishedDate.toLocaleDateString("en-US", { year: "numeric" }),
    month = publishedDate.toLocaleDateString("en-US", { month: "2-digit" }),
    day = publishedDate.toLocaleDateString("en-US", { day: "2-digit" });
  return `${year}-${month}-${day}`;
}

function getValidDateOnly(published: string): string | undefined {
  const match = DATE_ONLY_PATTERN.exec(published);
  if (!match) return undefined;

  const dateOnly = match[1];
  if (dateOnly === undefined) return undefined;
  const parsedDate = new Date(`${dateOnly}T00:00:00Z`);
  return !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === dateOnly
    ? dateOnly
    : undefined;
}
