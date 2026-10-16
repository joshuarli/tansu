export function normalizeTag(value: string): string | null {
  const tag = value.trim().replace(/^#/, "");
  return tag === "" || /[\r\n]/.test(tag) ? null : tag;
}
