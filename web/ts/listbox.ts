export function wrapSelectionIndex(current: number, delta: number, itemCount: number): number {
  const len = Math.max(itemCount, 1);
  return (current + delta + len) % len;
}

export function scrollSelectedIndexIntoView(
  container: HTMLElement | null,
  selectedIndex: number,
): void {
  queueMicrotask(() => {
    container?.children[selectedIndex]?.scrollIntoView({ block: "nearest" });
  });
}
