/// Lightweight typed event bus for cross-module communication.

import type { Tab } from "./tab-state.ts";

interface EventMap {
  "tab:render": undefined;
  "tab:change": Tab | null;
  "tab:close": Tab;
  "files:changed": undefined;
  "pinned:changed": undefined;
  "revision:restore": { content: string; mtime: number };
  "file:rename": { oldPath: string; newPath: string };
  notification: { msg: string; type: "error" | "info" | "success" };
}

type Handler<T> = (data: T) => void;

const listeners = new Map<string, Set<Handler<unknown>>>();

type EmitArgs<T> = T extends undefined ? [] : [data: T];

/// Subscribe to an event. Returns an unsubscribe function.
export function on<K extends keyof EventMap>(event: K, handler: Handler<EventMap[K]>): () => void {
  if (!listeners.has(event)) {
    listeners.set(event, new Set());
  }
  const set = listeners.get(event)!;
  set.add(handler as Handler<unknown>);
  return () => set.delete(handler as Handler<unknown>);
}

/// Emit an event to all subscribers.
export function emit<K extends keyof EventMap>(event: K, ...args: EmitArgs<EventMap[K]>): void {
  for (const h of listeners.get(event) ?? []) {
    h(args[0] as unknown);
  }
}
