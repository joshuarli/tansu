import { For, Show, createEffect, createSignal } from "solid-js";

import { activateVault, getStatus, getVaults, type VaultEntry } from "./api.ts";
import { serverStore } from "./server-store.ts";
import { closeAllTabs, getTabs, restoreSession } from "./tab-state.ts";

export function VaultSwitcher() {
  const [vaults, setVaults] = createSignal<VaultEntry[]>([]);

  async function refresh() {
    try {
      setVaults(await getVaults());
    } catch {
      /* keep stale list */
    }
  }

  async function handleVaultSwitch(index: number): Promise<void> {
    const dirty = getTabs().filter((tab) => tab.dirty);
    if (dirty.length > 0) {
      const names = dirty.map((tab) => tab.title || tab.path).join(", ");
      if (!confirm(`Unsaved changes in: ${names}. Discard and switch vault?`)) {
        await refresh();
        return;
      }
    }

    const ok = await activateVault(index);
    if (!ok) {
      await refresh();
      return;
    }

    closeAllTabs();
    const status = await getStatus().catch(() => null);
    if (!status?.locked) {
      await restoreSession();
    }
    await serverStore.handleVaultSwitched(status?.locked ?? false);
  }

  createEffect(() => {
    serverStore.vaultVersion();
    void refresh();
  });

  return (
    <Show when={vaults().length > 1}>
      <select
        class="vault-select"
        title="Switch vault"
        aria-label="Switch vault"
        onChange={(e) => {
          const index = Number(e.currentTarget.value);
          void handleVaultSwitch(index);
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
