/// Lightweight typed event bus for cross-module communication.

import type { Tab } from "./tab-state.ts";

type EventMap = {
  "tab:change": Tab | null;
  "files:changed": { savedPath?: string } | undefined;
  "pinned:changed": undefined;
  "revision:restore": { content: string; mtime: number };
  "file:rename": { oldPath: string; newPath: string };
  "vault:switched": undefined;
  notification: { msg: string; type: "error" | "info" | "success" };
};

type Handler<K extends keyof EventMap> = (data: EventMap[K]) => void;
type EmitArgs<T> = undefined extends T ? [data?: Exclude<T, undefined>] : [data: T];
type AnyHandler = (data: unknown) => void;

const listeners = new Map<keyof EventMap, Set<AnyHandler>>();

function getListeners(event: keyof EventMap): Set<AnyHandler> {
  let set = listeners.get(event);
  if (!set) {
    set = new Set<AnyHandler>();
    listeners.set(event, set);
  }
  return set;
}

/// Subscribe to an event. Returns an unsubscribe function.
export function on<K extends keyof EventMap>(event: K, handler: Handler<K>): () => void {
  const set = getListeners(event);
  set.add(handler as AnyHandler);
  return () => set.delete(handler as AnyHandler);
}

/// Emit an event to all subscribers.
export function emit<K extends keyof EventMap>(event: K, ...args: EmitArgs<EventMap[K]>): void {
  for (const handler of getListeners(event)) {
    handler(args[0]);
  }
}
