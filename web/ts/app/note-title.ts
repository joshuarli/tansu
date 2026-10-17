const MAX_TITLE_LENGTH = 80;

export function titleFromSource(source: string): string {
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  for (const line of body.split(/\r?\n/)) {
    const title = line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)+/, "").trim();
    if (title !== "") return title.slice(0, MAX_TITLE_LENGTH).trim();
  }
  return "Untitled";
}
