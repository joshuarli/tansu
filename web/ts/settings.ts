import {
  getSettings,
  saveSettings,
  getStatus,
  registerPrf,
  removePrf,
  lockApp,
  type Settings,
  type AppStatus,
} from "./api.ts";
import {
  SETTINGS_FUZZY_DISTANCE_DEFAULT,
  SETTINGS_FUZZY_DISTANCE_OPTIONS,
  SETTINGS_RECENCY_BOOST_DEFAULT,
  SETTINGS_RECENCY_BOOST_OPTIONS,
  SETTINGS_RESULT_LIMIT_DEFAULT,
  SETTINGS_RESULT_LIMIT_MAX,
  SETTINGS_RESULT_LIMIT_MIN,
  SETTINGS_RESULT_LIMIT_STEP,
  SETTINGS_SHOW_SCORE_BREAKDOWN_DEFAULT,
  SETTINGS_WEIGHT_CONTENT_DEFAULT,
  SETTINGS_WEIGHT_HEADINGS_DEFAULT,
  SETTINGS_WEIGHT_MAX,
  SETTINGS_WEIGHT_MIN,
  SETTINGS_WEIGHT_STEP,
  SETTINGS_WEIGHT_TAGS_DEFAULT,
  SETTINGS_WEIGHT_TITLE_DEFAULT,
} from "./constants.ts";
import { showInputDialog } from "./input-dialog.ts";
import { isPrfLikelySupported, createPrfCredential } from "./webauthn.ts";

type SettingsPanel = {
  toggle(): void;
  open(): Promise<void>;
  close(): void;
  isOpen(): boolean;
};

function recencyLabel(value: number): string {
  if (value === 0) {
    return "Disabled";
  }
  if (value === 1) {
    return "24 hours";
  }
  if (value === 2) {
    return "7 days";
  }
  return "30 days";
}

export function createSettings(): SettingsPanel {
  const overlay = document.querySelector("#settings-overlay")!;
  const panel = document.querySelector("#settings-panel")!;
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
    } catch {
      current = {
        weight_title: SETTINGS_WEIGHT_TITLE_DEFAULT,
        weight_headings: SETTINGS_WEIGHT_HEADINGS_DEFAULT,
        weight_tags: SETTINGS_WEIGHT_TAGS_DEFAULT,
        weight_content: SETTINGS_WEIGHT_CONTENT_DEFAULT,
        fuzzy_distance: SETTINGS_FUZZY_DISTANCE_DEFAULT,
        recency_boost: SETTINGS_RECENCY_BOOST_DEFAULT,
        result_limit: SETTINGS_RESULT_LIMIT_DEFAULT,
        show_score_breakdown: SETTINGS_SHOW_SCORE_BREAKDOWN_DEFAULT,
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
    if (isOpen) {
      close();
    } else {
      open();
    }
  }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      close();
    }
  });

  function render() {
    if (!current) {
      return;
    }
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
            ${SETTINGS_FUZZY_DISTANCE_OPTIONS.map(
              (value) =>
                `<option value="${value}"${s.fuzzy_distance === value ? " selected" : ""}>${
                  value === 0 ? "0 (exact only)" : value
                }</option>`,
            ).join("")}
          </select>
        </label>
        <label class="settings-row">
          <span>Recency boost</span>
          <select data-key="recency_boost">
            ${SETTINGS_RECENCY_BOOST_OPTIONS.map(
              (value) =>
                `<option value="${value}"${s.recency_boost === value ? " selected" : ""}>${recencyLabel(value)}</option>`,
            ).join("")}
          </select>
        </label>
        <label class="settings-row">
          <span>Result limit</span>
          <input type="number" data-key="result_limit" value="${s.result_limit}" min="${SETTINGS_RESULT_LIMIT_MIN}" max="${SETTINGS_RESULT_LIMIT_MAX}" step="${SETTINGS_RESULT_LIMIT_STEP}">
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

    // Wire up sliders to show current value as the thumb moves.
    // Sliders are numeric range inputs — live update is fine and expected.
    for (const input of panel.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
      const val = input.nextElementSibling as HTMLSpanElement;
      input.addEventListener("input", () => {
        val.textContent = input.value;
      });
    }

    // Excluded-folders field: only save on blur or Enter to avoid triggering
    // a full server-side reindex on every keystroke.
    const foldersInput = panel.querySelector<HTMLInputElement>(
      'input[data-key="excluded_folders"]',
    );
    if (foldersInput) {
      foldersInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          save();
        }
      });
    }

    panel.querySelector("#settings-save")!.addEventListener("click", save);
    panel.querySelector("#settings-cancel")!.addEventListener("click", close);
    wireSecuritySection();
  }

  async function save() {
    if (!current) {
      return;
    }

    const updated = { ...current };
    const validKeys = new Set<string>(Object.keys(updated));

    function isSettingKey(k: string): k is keyof Settings {
      return validKeys.has(k);
    }

    for (const el of panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]")) {
      const raw = el.dataset["key"] ?? "";
      if (!isSettingKey(raw)) {
        continue;
      }
      const key = raw;

      if (el instanceof HTMLInputElement && el.type === "checkbox") {
        Object.assign(updated, { [key]: el.checked });
      } else if (el instanceof HTMLInputElement && el.type === "range") {
        Object.assign(updated, { [key]: Number.parseFloat(el.value) });
      } else if (el instanceof HTMLInputElement && el.type === "number") {
        Object.assign(updated, { [key]: Number.parseInt(el.value, 10) });
      } else if (el instanceof HTMLSelectElement) {
        Object.assign(updated, { [key]: Number.parseInt(el.value, 10) });
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
    } catch {
      // save failed silently
    }
  }

  function renderSecuritySection(): string {
    if (!status || !status.encrypted) {
      return "";
    }

    const names = status.prf_credential_names;
    const ids = status.prf_credential_ids;
    const rows = ids
      .map(
        (id, i) =>
          `<div class="settings-row">
            <span>${names[i] || `${id.slice(0, 12)}...`}</span>
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

  /* c8 ignore start */
  function wireSecuritySection() {
    if (!status || !status.encrypted) {
      return;
    }

    const statusEl = panel.querySelector("#security-status") as HTMLElement | null;

    // Remove credential buttons
    for (const btn of panel.querySelectorAll<HTMLButtonElement>(".prf-remove")) {
      // eslint-disable-next-line no-loop-func
      btn.addEventListener("click", async () => {
        const id = btn.dataset["id"]!;
        if (!confirm("Remove this biometric credential?")) {
          return;
        }
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
        if (statusEl) {
          statusEl.textContent = "Waiting for biometrics...";
        }
        try {
          const result = await createPrfCredential();
          const name =
            (await showInputDialog("Name this credential", "e.g. MacBook Touch ID")) || "Unnamed";
          if (statusEl) {
            statusEl.textContent = "Registering...";
          }
          const ok = await registerPrf(result.credentialId, result.prfKeyB64, name);
          if (ok) {
            status = await getStatus();
            render();
          } else if (statusEl) {
            statusEl.textContent = "Registration failed.";
          }
        } catch (error) {
          if (statusEl) {
            statusEl.textContent = error instanceof Error ? error.message : "Failed.";
          }
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
  /* c8 ignore stop */

  return { toggle, open, close, isOpen: () => isOpen };
}

function slider(key: string, label: string, value: number): string {
  return `
    <label class="settings-row">
      <span>${label}</span>
      <input type="range" data-key="${key}" min="${SETTINGS_WEIGHT_MIN}" max="${SETTINGS_WEIGHT_MAX}" step="${SETTINGS_WEIGHT_STEP}" value="${value}">
      <span class="slider-value">${value}</span>
    </label>`;
}
