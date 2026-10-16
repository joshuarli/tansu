import { normalizeTag } from "./markdown-tags.ts";

export type TagPillElement = "button" | "span";

const HUE_COUNT = 360;
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function tagHue(tag: string): number {
  const normalized = requireNormalizedTag(tag);
  let hash = FNV_OFFSET_BASIS;
  for (const unit of new TextEncoder().encode(normalized.toLowerCase())) {
    hash = Math.imul(hash ^ unit, FNV_PRIME) >>> 0;
  }
  return hash % HUE_COUNT;
}

export function createTagPill<K extends TagPillElement>(tag: string, element: K): HTMLElementTagNameMap[K] {
  const normalized = requireNormalizedTag(tag);
  const pill = document.createElement(element);
  if (pill instanceof HTMLButtonElement) pill.type = "button";
  pill.className = "tag tag-pill";
  pill.style.setProperty("--tag-hue", String(tagHue(normalized)));
  const label = document.createElement("span");
  label.className = "tag-pill-label";
  label.textContent = `#${normalized}`;
  pill.append(label);
  return pill;
}

function requireNormalizedTag(tag: string): string {
  const normalized = normalizeTag(tag);
  if (normalized === null) throw new Error(`Invalid tag: ${JSON.stringify(tag)}`);
  return normalized;
}
