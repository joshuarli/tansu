import { getVaults, activateVault, type VaultEntry } from "./api.ts";
import { emit } from "./events.ts";
import { getTabs, closeAllTabs, restoreSession } from "./tab-state.ts";

let vaults: VaultEntry[] = [];

function getContainer(): HTMLElement | null {
  return document.querySelector("#vault-switcher");
}

function renderVaultSwitcher(): void {
  const container = getContainer();
  if (!container) return;

  if (vaults.length <= 1) {
    container.innerHTML = "";
    return;
  }

  const select = document.createElement("select");
  select.id = "vault-select";
  select.title = "Switch vault";

  for (const v of vaults) {
    const opt = document.createElement("option");
    opt.value = String(v.index);
    opt.selected = v.active;
    opt.textContent = v.locked ? `${v.name} 🔒` : v.name;
    select.append(opt);
  }

  select.addEventListener("change", () => {
    const idx = Number(select.value);
    void handleVaultSwitch(idx);
  });

  container.innerHTML = "";
  container.append(select);
}

async function handleVaultSwitch(index: number): Promise<void> {
  const dirty = getTabs().filter((t) => t.dirty);
  if (dirty.length > 0) {
    const names = dirty.map((t) => t.title || t.path).join(", ");
    if (!confirm(`Unsaved changes in: ${names}. Discard and switch vault?`)) {
      renderVaultSwitcher(); // reset select back to current vault
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
