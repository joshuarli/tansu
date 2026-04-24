export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function relativeTime(tsMs: number, now: number = Date.now()): string {
  const diff = Math.floor((now - tsMs) / 1000);
  if (diff < 60) {
    return "just now";
  }
  if (diff < 3600) {
    return `${Math.floor(diff / 60)}m ago`;
  }
  if (diff < 86_400) {
    return `${Math.floor(diff / 3600)}h ago`;
  }
  if (diff < 604_800) {
    return `${Math.floor(diff / 86_400)}d ago`;
  }
  const d = new Date(tsMs);
  return d.toLocaleDateString();
}

export function stemFromPath(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.md$/i, "");
}
