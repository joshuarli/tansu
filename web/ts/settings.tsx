import { For, Show, createSignal } from "solid-js";

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
import { getEditorPrefs, saveEditorPrefs, type EditorPrefs } from "./editor.ts";
import { showInputDialog } from "./input-dialog.tsx";
import { createManagedModal } from "./managed-modal.ts";
import { reportActionError } from "./notify.ts";
import { OverlayFrame } from "./overlay.tsx";
import { uiStore } from "./ui-store.ts";
import { createPrfCredential, isPrfLikelySupported } from "./webauthn.ts";

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

function normalizeExcludedFolders(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

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
  editorPrefs: () => EditorPrefs;
  onEditorUndoStackMax: (value: string) => void;
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
            <div class="settings-section">
              <h3>Editor</h3>
              <label class="settings-row">
                <span>Undo history</span>
                <input
                  type="number"
                  min="50"
                  max="1000"
                  step="50"
                  value={props.editorPrefs().undoStackMax}
                  onInput={(e) => props.onEditorUndoStackMax(e.currentTarget.value)}
                />
              </label>
            </div>
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

type SettingsModalProps = {
  onApplyEditorPrefs?: (prefs: EditorPrefs) => void;
};

export function SettingsModal(props: Readonly<SettingsModalProps> = {}) {
  const [current, setCurrent] = createSignal<Settings | null>(null);
  const [editorPrefs, setEditorPrefs] = createSignal<EditorPrefs>(getEditorPrefs());
  const [status, setStatus] = createSignal<AppStatus | null>(null);
  const [securityStatus, setSecurityStatus] = createSignal("");

  function close() {
    uiStore.closeSettings();
  }

  async function open() {
    setSecurityStatus("");
    setEditorPrefs(getEditorPrefs());
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

  async function save() {
    const snapshot = current();
    if (!snapshot) {
      return;
    }
    const updated: Settings = {
      ...snapshot,
      excluded_folders: normalizeExcludedFolders(snapshot.excluded_folders),
    };

    try {
      await saveSettings(updated);
      const nextEditorPrefs = editorPrefs();
      saveEditorPrefs(nextEditorPrefs);
      props.onApplyEditorPrefs?.(nextEditorPrefs);
      setCurrent(updated);
      close();
    } catch (error) {
      reportActionError("Failed to save settings", error);
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

  const modal = createManagedModal({
    id: "settings",
    isRequestedOpen: uiStore.isSettingsRequestedOpen,
    onOpen: () => {
      void open();
    },
    onClose: close,
  });

  return (
    <OverlayFrame id="settings-overlay" isOpen={modal.isOpen()} onClose={modal.close}>
      <div id="settings-panel" role="dialog" aria-modal="true" aria-label="Settings">
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
                    excluded_folders: normalizeExcludedFolders(value.split(",")),
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
          editorPrefs={editorPrefs}
          onEditorUndoStackMax={(value) => {
            const n = Number.parseInt(value, 10);
            if (!Number.isNaN(n)) setEditorPrefs((prev) => ({ ...prev, undoStackMax: n }));
          }}
        />
      </div>
    </OverlayFrame>
  );
}
