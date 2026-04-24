/// Lightweight typed event bus for cross-module communication.

type Handler<T = unknown> = (data: T) => void;

const listeners = new Map<string, Set<Handler>>();

/// Subscribe to an event. Returns an unsubscribe function.
export function on<T = unknown>(event: string, handler: Handler<T>): () => void {
  if (!listeners.has(event)) {
    listeners.set(event, new Set());
  }
  const set = listeners.get(event)!;
  set.add(handler as Handler);
  return () => set.delete(handler as Handler);
}

/// Emit an event to all subscribers.
export function emit<T = unknown>(event: string, data?: T): void {
  for (const h of listeners.get(event) ?? []) {
    h(data as T);
  }
}
