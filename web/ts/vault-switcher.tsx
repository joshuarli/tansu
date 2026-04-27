import { For, Show, createSignal } from "solid-js";
import { render } from "solid-js/web";

import { activateVault, getVaults, type VaultEntry } from "./api.ts";
import { emit } from "./events.ts";
import { closeAllTabs, getTabs, restoreSession } from "./tab-state.ts";

const [vaults, setVaults] = createSignal<VaultEntry[]>([]);
let mounted = false;

function getContainer(): HTMLElement | null {
  return document.querySelector("#vault-switcher");
}

function VaultSwitcher() {
  return (
    <Show when={vaults().length > 1}>
      <select
        class="vault-select"
        title="Switch vault"
        aria-label="Switch vault"
        onChange={(e) => {
          const idx = Number(e.currentTarget.value);
          void handleVaultSwitch(idx);
        }}
      >
        <For each={vaults()}>
          {(vault) => (
            <option value={String(vault.index)} selected={vault.active}>
              {vault.locked ? `${vault.name} 🔒` : vault.name}
            </option>
          )}
        </For>
      </select>
    </Show>
  );
}

async function handleVaultSwitch(index: number): Promise<void> {
  const dirty = getTabs().filter((t) => t.dirty);
  if (dirty.length > 0) {
    const names = dirty.map((t) => t.title || t.path).join(", ");
    if (!confirm(`Unsaved changes in: ${names}. Discard and switch vault?`)) {
      try {
        setVaults(await getVaults());
      } catch {
        // keep stale list
      }
      return;
    }
  }

  const ok = await activateVault(index);
  if (!ok) {
    try {
      setVaults(await getVaults());
    } catch {
      // keep stale list
    }
    return;
  }

  closeAllTabs();
  await restoreSession();

  try {
    setVaults(await getVaults());
  } catch {
    // keep stale list
  }

  emit("vault:switched");
  emit("files:changed", {});
}

export async function initVaultSwitcher(): Promise<void> {
  if (!mounted) {
    const container = getContainer();
    if (container instanceof HTMLElement) {
      render(() => <VaultSwitcher />, container);
      mounted = true;
    }
  }
  try {
    setVaults(await getVaults());
  } catch {
    return;
  }
}

export async function refreshVaultSwitcher(): Promise<void> {
  try {
    setVaults(await getVaults());
  } catch {
    return;
  }
}
