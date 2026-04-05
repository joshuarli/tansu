import { getSettings, saveSettings, getStatus, registerPrf, removePrf, lockApp } from "./api.ts";
import type { Settings, AppStatus } from "./api.ts";
import { isPrfLikelySupported, createPrfCredential } from "./webauthn.ts";

export interface SettingsPanel {
  toggle(): void;
  open(): Promise<void>;
  close(): void;
  isOpen(): boolean;
}

export function createSettings(): SettingsPanel {
  const overlay = document.getElementById("settings-overlay")!;
  const panel = document.getElementById("settings-panel")!;
  let isOpen = false;
  let current: Settings | null = null;
  let status: AppStatus | null = null;

  function close() {
    isOpen = false;
    overlay.classList.add("hidden");
  }

  async function open() {
    isOpen = true;
    overlay.classList.remove("hidden");
    try {
      current = await getSettings();
    } catch (e) {
      console.warn("Failed to load settings, using defaults:", e);
      current = {
        weight_title: 10,
        weight_headings: 5,
        weight_tags: 2,
        weight_content: 1,
        fuzzy_distance: 1,
        result_limit: 20,
        show_score_breakdown: true,
        excluded_folders: [],
      };
    }
    try {
      status = await getStatus();
    } catch {
      status = null;
    }
    render();
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  function render() {
    if (!current) return;
    const s = current;

    panel.innerHTML = `
      <h2>Settings</h2>
      <div class="settings-section">
        <h3>Search weights</h3>
        ${slider("weight_title", "Title", s.weight_title)}
        ${slider("weight_headings", "Headings", s.weight_headings)}
        ${slider("weight_tags", "Tags", s.weight_tags)}
        ${slider("weight_content", "Content", s.weight_content)}
      </div>
      <div class="settings-section">
        <h3>Search options</h3>
        <label class="settings-row">
          <span>Fuzzy distance</span>
          <select data-key="fuzzy_distance">
            <option value="0"${s.fuzzy_distance === 0 ? " selected" : ""}>0 (exact only)</option>
            <option value="1"${s.fuzzy_distance === 1 ? " selected" : ""}>1</option>
            <option value="2"${s.fuzzy_distance === 2 ? " selected" : ""}>2</option>
          </select>
        </label>
        <label class="settings-row">
          <span>Result limit</span>
          <input type="number" data-key="result_limit" value="${s.result_limit}" min="5" max="100" step="5">
        </label>
        <label class="settings-row">
          <span>Show score breakdown</span>
          <input type="checkbox" data-key="show_score_breakdown"${s.show_score_breakdown ? " checked" : ""}>
        </label>
      </div>
      <div class="settings-section">
        <h3>Excluded folders</h3>
        <p class="settings-hint">Comma-separated folder names to exclude from indexing. Changes trigger a reindex.</p>
        <input type="text" data-key="excluded_folders" class="settings-text" value="${s.excluded_folders.join(", ")}" placeholder="archive, drafts">
      </div>
      ${renderSecuritySection()}
      <div class="settings-actions">
        <button id="settings-save">Save</button>
        <button id="settings-cancel">Cancel</button>
      </div>
    `;

    // Wire up sliders to show value
    for (const input of panel.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
      const val = input.nextElementSibling as HTMLSpanElement;
      input.addEventListener("input", () => {
        val.textContent = input.value;
      });
    }

    panel.querySelector("#settings-save")!.addEventListener("click", save);
    panel.querySelector("#settings-cancel")!.addEventListener("click", close);
    wireSecuritySection();
  }

  async function save() {
    if (!current) return;

    const updated = { ...current };

    for (const el of panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]")) {
      const key = el.dataset["key"] as keyof Settings;
      if (!key) continue;

      if (el instanceof HTMLInputElement && el.type === "checkbox") {
        (updated as Record<string, unknown>)[key] = el.checked;
      } else if (el instanceof HTMLInputElement && el.type === "range") {
        (updated as Record<string, unknown>)[key] = parseFloat(el.value);
      } else if (el instanceof HTMLInputElement && el.type === "number") {
        (updated as Record<string, unknown>)[key] = parseInt(el.value, 10);
      } else if (el instanceof HTMLSelectElement) {
        (updated as Record<string, unknown>)[key] = parseInt(el.value, 10);
      } else if (key === "excluded_folders") {
        updated.excluded_folders = (el as HTMLInputElement).value
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      }
    }

    try {
      await saveSettings(updated);
      current = updated;
      close();
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  }

  function renderSecuritySection(): string {
    if (!status || !status.encrypted) return "";

    const names = status.prf_credential_names;
    const ids = status.prf_credential_ids;
    const rows = ids
      .map(
        (id, i) =>
          `<div class="settings-row">
            <span>${names[i] || id.slice(0, 12) + "..."}</span>
            <button class="prf-remove" data-id="${id}">Remove</button>
          </div>`,
      )
      .join("");

    const canAdd = isPrfLikelySupported();
    return `
      <div class="settings-section">
        <h3>Security</h3>
        ${ids.length > 0 ? `<p class="settings-hint">Registered biometric credentials:</p>${rows}` : '<p class="settings-hint">No biometric credentials registered.</p>'}
        ${canAdd ? '<button id="prf-add">Add biometric credential</button>' : '<p class="settings-hint">WebAuthn PRF not available in this browser.</p>'}
        <button id="lock-now" style="margin-top:8px">Lock now</button>
        <div id="security-status" style="min-height:1.6em;font-size:13px;color:var(--fg-muted)"></div>
      </div>
    `;
  }

  function wireSecuritySection() {
    if (!status || !status.encrypted) return;

    const statusEl = panel.querySelector("#security-status") as HTMLElement | null;

    // Remove credential buttons
    for (const btn of panel.querySelectorAll<HTMLButtonElement>(".prf-remove")) {
      btn.addEventListener("click", async () => {
        const id = btn.dataset["id"]!;
        if (!confirm("Remove this biometric credential?")) return;
        btn.disabled = true;
        const ok = await removePrf(id);
        if (ok) {
          status = await getStatus();
          render();
        } else if (statusEl) {
          statusEl.textContent = "Failed to remove credential.";
        }
      });
    }

    // Add credential button
    const addBtn = panel.querySelector("#prf-add") as HTMLButtonElement | null;
    if (addBtn) {
      addBtn.addEventListener("click", async () => {
        if (statusEl) statusEl.textContent = "Waiting for biometrics...";
        try {
          const result = await createPrfCredential();
          const name = prompt("Name this credential (e.g. 'MacBook Touch ID')") || "Unnamed";
          if (statusEl) statusEl.textContent = "Registering...";
          const ok = await registerPrf(result.credentialId, result.prfKeyB64, name);
          if (ok) {
            status = await getStatus();
            render();
          } else if (statusEl) {
            statusEl.textContent = "Registration failed.";
          }
        } catch (e) {
          if (statusEl) statusEl.textContent = e instanceof Error ? e.message : "Failed.";
        }
      });
    }

    // Lock button
    const lockBtn = panel.querySelector("#lock-now") as HTMLButtonElement | null;
    if (lockBtn) {
      lockBtn.addEventListener("click", async () => {
        await lockApp();
        close();
      });
    }
  }

  return { toggle, open, close, isOpen: () => isOpen };
}

function slider(key: string, label: string, value: number): string {
  return `
    <label class="settings-row">
      <span>${label}</span>
      <input type="range" data-key="${key}" min="0" max="20" step="0.5" value="${value}">
      <span class="slider-value">${value}</span>
    </label>`;
}
