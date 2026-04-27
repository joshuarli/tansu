import { For, Show, createSignal } from "solid-js";
import { render } from "solid-js/web";

import {
  getSettings,
  getStatus,
  lockApp,
  registerPrf,
  removePrf,
  saveSettings,
  type AppStatus,
  type Settings,
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
import { showInputDialog } from "./input-dialog.tsx";
import { createPrfCredential, isPrfLikelySupported } from "./webauthn.ts";

type SettingsPanel = {
  toggle(): void;
  open(): Promise<void>;
  close(): void;
  isOpen(): boolean;
};

const defaultSettings = (): Settings => ({
  weight_title: SETTINGS_WEIGHT_TITLE_DEFAULT,
  weight_headings: SETTINGS_WEIGHT_HEADINGS_DEFAULT,
  weight_tags: SETTINGS_WEIGHT_TAGS_DEFAULT,
  weight_content: SETTINGS_WEIGHT_CONTENT_DEFAULT,
  fuzzy_distance: SETTINGS_FUZZY_DISTANCE_DEFAULT,
  recency_boost: SETTINGS_RECENCY_BOOST_DEFAULT,
  result_limit: SETTINGS_RESULT_LIMIT_DEFAULT,
  show_score_breakdown: SETTINGS_SHOW_SCORE_BREAKDOWN_DEFAULT,
  excluded_folders: [],
});

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

type SettingsViewProps = {
  current: () => Settings | null;
  status: () => AppStatus | null;
  onRange: (key: keyof Settings, value: string) => void;
  onSelect: (key: keyof Settings, value: string) => void;
  onNumber: (key: keyof Settings, value: string) => void;
  onCheckbox: (key: keyof Settings, checked: boolean) => void;
  onFolders: (value: string) => void;
  onFoldersKeyDown: (e: KeyboardEvent) => void;
  onSave: () => void;
  onClose: () => void;
  onRemovePrf: (id: string) => void;
  onAddPrf: () => void;
  onLock: () => void;
  securityStatus: () => string;
};

function SettingsView(props: Readonly<SettingsViewProps>) {
  return (
    <>
      <Show
        when={props.current()}
        fallback={
          <p style={{ padding: "1rem", color: "var(--fg-muted)", "font-size": "13px" }}>
            Loading...
          </p>
        }
      >
        {(current) => (
          <>
            <h2>Settings</h2>
            <div class="settings-section">
              <h3>Search weights</h3>
              <label class="settings-row">
                <span>Title</span>
                <input
                  type="range"
                  data-key="weight_title"
                  min={SETTINGS_WEIGHT_MIN}
                  max={SETTINGS_WEIGHT_MAX}
                  step={SETTINGS_WEIGHT_STEP}
                  value={current().weight_title}
                  onInput={(e) => props.onRange("weight_title", e.currentTarget.value)}
                />
                <span class="slider-value">{current().weight_title}</span>
              </label>
              <label class="settings-row">
                <span>Headings</span>
                <input
                  type="range"
                  data-key="weight_headings"
                  min={SETTINGS_WEIGHT_MIN}
                  max={SETTINGS_WEIGHT_MAX}
                  step={SETTINGS_WEIGHT_STEP}
                  value={current().weight_headings}
                  onInput={(e) => props.onRange("weight_headings", e.currentTarget.value)}
                />
                <span class="slider-value">{current().weight_headings}</span>
              </label>
              <label class="settings-row">
                <span>Tags</span>
                <input
                  type="range"
                  data-key="weight_tags"
                  min={SETTINGS_WEIGHT_MIN}
                  max={SETTINGS_WEIGHT_MAX}
                  step={SETTINGS_WEIGHT_STEP}
                  value={current().weight_tags}
                  onInput={(e) => props.onRange("weight_tags", e.currentTarget.value)}
                />
                <span class="slider-value">{current().weight_tags}</span>
              </label>
              <label class="settings-row">
                <span>Content</span>
                <input
                  type="range"
                  data-key="weight_content"
                  min={SETTINGS_WEIGHT_MIN}
                  max={SETTINGS_WEIGHT_MAX}
                  step={SETTINGS_WEIGHT_STEP}
                  value={current().weight_content}
                  onInput={(e) => props.onRange("weight_content", e.currentTarget.value)}
                />
                <span class="slider-value">{current().weight_content}</span>
              </label>
            </div>
            <div class="settings-section">
              <h3>Search options</h3>
              <label class="settings-row">
                <span>Fuzzy distance</span>
                <select
                  data-key="fuzzy_distance"
                  value={String(current().fuzzy_distance)}
                  onChange={(e) => props.onSelect("fuzzy_distance", e.currentTarget.value)}
                >
                  <For each={SETTINGS_FUZZY_DISTANCE_OPTIONS}>
                    {(value) => (
                      <option value={String(value)}>
                        {value === 0 ? "0 (exact only)" : value}
                      </option>
                    )}
                  </For>
                </select>
              </label>
              <label class="settings-row">
                <span>Recency boost</span>
                <select
                  data-key="recency_boost"
                  value={String(current().recency_boost)}
                  onChange={(e) => props.onSelect("recency_boost", e.currentTarget.value)}
                >
                  <For each={SETTINGS_RECENCY_BOOST_OPTIONS}>
                    {(value) => <option value={String(value)}>{recencyLabel(value)}</option>}
                  </For>
                </select>
              </label>
              <label class="settings-row">
                <span>Result limit</span>
                <input
                  type="number"
                  data-key="result_limit"
                  value={current().result_limit}
                  min={SETTINGS_RESULT_LIMIT_MIN}
                  max={SETTINGS_RESULT_LIMIT_MAX}
                  step={SETTINGS_RESULT_LIMIT_STEP}
                  onInput={(e) => props.onNumber("result_limit", e.currentTarget.value)}
                />
              </label>
              <label class="settings-row">
                <span>Show score breakdown</span>
                <input
                  type="checkbox"
                  data-key="show_score_breakdown"
                  checked={current().show_score_breakdown}
                  onChange={(e) =>
                    props.onCheckbox("show_score_breakdown", e.currentTarget.checked)
                  }
                />
              </label>
            </div>
            <div class="settings-section">
              <h3>Excluded folders</h3>
              <p class="settings-hint">
                Comma-separated folder names to exclude from indexing. Changes trigger a reindex.
              </p>
              <input
                type="text"
                data-key="excluded_folders"
                class="settings-text"
                value={current().excluded_folders.join(", ")}
                placeholder="archive, drafts"
                onInput={(e) => props.onFolders(e.currentTarget.value)}
                onKeyDown={(e) => props.onFoldersKeyDown(e)}
              />
            </div>
            <Show when={props.status()?.encrypted}>
              <div class="settings-section">
                <h3>Security</h3>
                <Show
                  when={(props.status()?.prf_credential_ids.length ?? 0) > 0}
                  fallback={<p class="settings-hint">No biometric credentials registered.</p>}
                >
                  <>
                    <p class="settings-hint">Registered biometric credentials:</p>
                    <For each={props.status()?.prf_credential_ids ?? []}>
                      {(id, i) => (
                        <div class="settings-row">
                          <span>
                            {props.status()?.prf_credential_names[i()] || `${id.slice(0, 12)}...`}
                          </span>
                          <button
                            class="prf-remove"
                            data-id={id}
                            onClick={() => props.onRemovePrf(id)}
                          >
                            Remove
                          </button>
                        </div>
                      )}
                    </For>
                  </>
                </Show>
                <Show
                  when={isPrfLikelySupported()}
                  fallback={
                    <p class="settings-hint">WebAuthn PRF not available in this browser.</p>
                  }
                >
                  <button id="prf-add" onClick={props.onAddPrf}>
                    Add biometric credential
                  </button>
                </Show>
                <button id="lock-now" style={{ "margin-top": "8px" }} onClick={props.onLock}>
                  Lock now
                </button>
                <div
                  id="security-status"
                  style={{
                    "min-height": "1.6em",
                    "font-size": "13px",
                    color: "var(--fg-muted)",
                  }}
                >
                  {props.securityStatus()}
                </div>
              </div>
            </Show>
            <div class="settings-actions">
              <button id="settings-save" onClick={props.onSave}>
                Save
              </button>
              <button id="settings-cancel" onClick={props.onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </Show>
    </>
  );
}

export function createSettings(): SettingsPanel {
  const container = document.querySelector("#settings-root");
  if (!(container instanceof HTMLElement)) throw new Error("missing #settings-root");

  let panelEl: HTMLElement | null = null;
  let savedFocus: Element | null = null;
  const [isOpen, setIsOpen] = createSignal(false);
  const [current, setCurrent] = createSignal<Settings | null>(null);
  const [status, setStatus] = createSignal<AppStatus | null>(null);
  const [securityStatus, setSecurityStatus] = createSignal("");

  function close() {
    setIsOpen(false);
    if (savedFocus instanceof HTMLElement) {
      savedFocus.focus();
    }
    savedFocus = null;
  }

  async function open() {
    savedFocus = document.activeElement;
    setIsOpen(true);
    setSecurityStatus("");
    try {
      setCurrent(await getSettings());
    } catch {
      setCurrent(defaultSettings());
    }
    try {
      setStatus(await getStatus());
    } catch {
      setStatus(null);
    }
  }

  function toggle() {
    if (isOpen()) {
      close();
    } else {
      void open();
    }
  }

  async function save() {
    const snapshot = current();
    if (!snapshot || !panelEl) {
      return;
    }
    const updated = { ...snapshot };
    const validKeys = new Set<string>(Object.keys(updated));

    function isSettingKey(k: string): k is keyof Settings {
      return validKeys.has(k);
    }

    for (const el of panelEl.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]")) {
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
      setCurrent(updated);
      close();
    } catch {
      /* ignore */
    }
  }

  async function removeCredential(id: string) {
    if (!confirm("Remove this biometric credential?")) {
      return;
    }
    const ok = await removePrf(id);
    if (ok) {
      setStatus(await getStatus());
    } else {
      setSecurityStatus("Failed to remove credential.");
    }
  }

  async function addCredential() {
    setSecurityStatus("Waiting for biometrics...");
    try {
      const result = await createPrfCredential();
      const name =
        (await showInputDialog("Name this credential", "e.g. MacBook Touch ID")) || "Unnamed";
      setSecurityStatus("Registering...");
      const ok = await registerPrf(result.credentialId, result.prfKeyB64, name);
      if (ok) {
        setStatus(await getStatus());
        setSecurityStatus("");
      } else {
        setSecurityStatus("Registration failed.");
      }
    } catch (error) {
      setSecurityStatus(error instanceof Error ? error.message : "Failed.");
    }
  }

  async function lockNow() {
    await lockApp();
    close();
  }

  render(
    () => (
      <div
        id="settings-overlay"
        class={isOpen() ? "" : "hidden"}
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div
          id="settings-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          ref={(el) => {
            panelEl = el;
          }}
        >
          <SettingsView
            current={current}
            status={status}
            securityStatus={securityStatus}
            onRange={(key, value) => {
              setCurrent((prev) => (prev ? { ...prev, [key]: Number.parseFloat(value) } : prev));
            }}
            onSelect={(key, value) => {
              setCurrent((prev) => (prev ? { ...prev, [key]: Number.parseInt(value, 10) } : prev));
            }}
            onNumber={(key, value) => {
              setCurrent((prev) => (prev ? { ...prev, [key]: Number.parseInt(value, 10) } : prev));
            }}
            onCheckbox={(key, checked) => {
              setCurrent((prev) => (prev ? { ...prev, [key]: checked } : prev));
            }}
            onFolders={(value) => {
              setCurrent((prev) =>
                prev
                  ? {
                      ...prev,
                      excluded_folders: value
                        .split(",")
                        .map((s) => s.trim())
                        .filter((s) => s.length > 0),
                    }
                  : prev,
              );
            }}
            onFoldersKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void save();
              }
            }}
            onSave={() => {
              void save();
            }}
            onClose={close}
            onRemovePrf={(id) => {
              void removeCredential(id);
            }}
            onAddPrf={() => {
              void addCredential();
            }}
            onLock={() => {
              void lockNow();
            }}
          />
        </div>
      </div>
    ),
    container,
  );

  return { toggle, open, close, isOpen };
}
