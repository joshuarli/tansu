/// Assert that a DOM element matching `sel` exists. Use for elements that must be present
/// in the static HTML (e.g. #app, #tab-bar). Throws at initialization time if the markup is wrong.
function mustQuery<T extends HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) {
    throw new Error(`Required element not found: ${sel}`);
  }
  return el;
}

/// Suppress a rejected promise. Use only when failure is truly inconsequential.
function ignoreError(p: Promise<unknown>): void {
  p.catch(() => void 0);
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
