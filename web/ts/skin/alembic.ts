import { generateOrnament, type OrnamentPreset } from "./vendor/alembic-ornaments/index.ts";

type NamedOrnament = {
  name: string;
  preset: OrnamentPreset;
  seed: number;
};

const NAMED_ORNAMENTS: readonly NamedOrnament[] = [
  { name: "vine", preset: "vine", seed: 7 },
  { name: "sprig", preset: "sprig", seed: 11 },
];

export function installAlembicSkin(target: HTMLElement): void {
  for (const { name, preset, seed } of NAMED_ORNAMENTS) {
    const ornament = generateOrnament({ preset, seed });
    target.style.setProperty(`--skin-${name}`, `url("data:image/svg+xml,${encodeURIComponent(ornament.svg)}")`);
    target.style.setProperty(`--skin-${name}-aspect`, String(ornament.width / ornament.height));
  }
}
