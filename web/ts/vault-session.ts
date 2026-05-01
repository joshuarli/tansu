const ACTIVE_VAULT_KEY = "tansu_vault";

function parseActiveVaultValue(raw: string | null): number {
  const index = Number(raw);
  return Number.isInteger(index) && index >= 0 ? index : 0;
}

export function getActiveVaultIndex(): number {
  if (typeof sessionStorage === "undefined") {
    return 0;
  }
  return parseActiveVaultValue(sessionStorage.getItem(ACTIVE_VAULT_KEY));
}

export function setActiveVaultIndex(index: number): void {
  if (typeof sessionStorage === "undefined") {
    return;
  }
  sessionStorage.setItem(ACTIVE_VAULT_KEY, String(index));
}

export function vaultScopedKeyFor(index: number, key: string): string {
  return `vault:${index}:${key}`;
}

export function vaultScopedNoteKeyFor(index: number, path: string): string {
  return vaultScopedKeyFor(index, `note:${path}`);
}
