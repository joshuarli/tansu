import { render } from "solid-js/web";

import { activateVault, getVaults, type VaultEntry } from "./api.ts";
import { emit } from "./events.ts";
import { closeAllTabs, getTabs, restoreSession } from "./tab-state.ts";

let vaults: VaultEntry[] = [];
let disposeRoot: (() => void) | null = null;

function getContainer(): HTMLElement | null {
  return document.querySelector("#vault-switcher");
}

function VaultSwitcher(props: Readonly<{ vaults: readonly VaultEntry[] }>) {
  return (
    <select
      id="vault-select"
      title="Switch vault"
      aria-label="Switch vault"
      onChange={(e) => {
        const idx = Number(e.currentTarget.value);
        void handleVaultSwitch(idx);
      }}
    >
      {props.vaults.map((vault) => (
        <option value={String(vault.index)} selected={vault.active}>
          {vault.locked ? `${vault.name} 🔒` : vault.name}
        </option>
      ))}
    </select>
  );
}

function renderVaultSwitcher(): void {
  const container = getContainer();
  if (!container) {
    return;
  }

  disposeRoot?.();
  disposeRoot = null;
  container.textContent = "";

  if (vaults.length <= 1) {
    return;
  }

  disposeRoot = render(() => <VaultSwitcher vaults={vaults} />, container);
}

async function handleVaultSwitch(index: number): Promise<void> {
  const dirty = getTabs().filter((t) => t.dirty);
  if (dirty.length > 0) {
    const names = dirty.map((t) => t.title || t.path).join(", ");
    if (!confirm(`Unsaved changes in: ${names}. Discard and switch vault?`)) {
      renderVaultSwitcher();
      return;
    }
  }

  const ok = await activateVault(index);
  if (!ok) {
    renderVaultSwitcher();
    return;
  }

  closeAllTabs();
  await restoreSession();

  try {
    vaults = await getVaults();
  } catch {
    // keep stale list
  }
  renderVaultSwitcher();

  emit("vault:switched");
  emit("files:changed", {});
}

export async function initVaultSwitcher(): Promise<void> {
  try {
    vaults = await getVaults();
  } catch {
    return;
  }
  renderVaultSwitcher();
}

export async function refreshVaultSwitcher(): Promise<void> {
  try {
    vaults = await getVaults();
  } catch {
    return;
  }
  renderVaultSwitcher();
}
