import {
  SECONDS_PER_MINUTE,
  SECONDS_PER_HOUR,
  SECONDS_PER_DAY,
  SECONDS_PER_WEEK,
} from "./constants.ts";

export function relativeTime(tsMs: number, now: number = Date.now()): string {
  const diff = Math.floor((now - tsMs) / 1000);
  if (diff < SECONDS_PER_MINUTE) {
    return "just now";
  }
  if (diff < SECONDS_PER_HOUR) {
    return `${Math.floor(diff / SECONDS_PER_MINUTE)}m ago`;
  }
  if (diff < SECONDS_PER_DAY) {
    return `${Math.floor(diff / SECONDS_PER_HOUR)}h ago`;
  }
  if (diff < SECONDS_PER_WEEK) {
    return `${Math.floor(diff / SECONDS_PER_DAY)}d ago`;
  }
  const d = new Date(tsMs);
  return d.toLocaleDateString();
}
