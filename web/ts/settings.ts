import { getSettings, saveSettings } from "./api.ts";
import type { Settings } from "./api.ts";

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
