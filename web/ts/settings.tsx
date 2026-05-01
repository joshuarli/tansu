import { For, Show, createSignal, type JSX } from "solid-js";

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
import { showInputDialog } from "./input-dialog.tsx";
import { createManagedModal } from "./modal-manager.ts";
import { reportActionError } from "./notify.ts";
import { OverlayFrame } from "./overlay.tsx";
import {
  APP_SETTINGS_SECTION_ORDER,
  APP_SETTING_FIELDS,
  SERVER_SETTINGS_SECTION_ORDER,
  SERVER_SETTING_FIELDS,
  VAULT_SETTINGS_SECTION_ORDER,
  VAULT_SETTING_FIELDS,
  defaultSettings,
  getAppSettings,
  getFieldEntries,
  getVaultSettings,
  normalizeExcludedFolders,
  parseCheckboxField,
  parseStringField,
  saveAppSettings,
  saveVaultSettings,
  type AppSectionId,
  type AppSettings,
  type FieldEntry,
  type FieldRegistry,
  type SectionId,
  type ServerSectionId,
  type VaultSectionId,
  type VaultSettings,
  updateObjectField,
} from "./settings.ts";
import { uiStore } from "./ui-store.ts";
import { createPrfCredential, isPrfLikelySupported } from "./webauthn.ts";

type SettingsSectionsViewProps<
  Model extends Record<string, unknown>,
  TSection extends SectionId,
> = {
  title: string;
  current: () => Model | null;
  sections: readonly { id: TSection; title: string }[];
  registry: FieldRegistry<Model>;
  scope: string;
  saveId: string;
  cancelId: string;
  onInput: <K extends keyof Model>(key: K, value: string) => void;
  onToggle: <K extends keyof Model>(key: K, checked: boolean) => void;
  onSave: () => void;
  onClose: () => void;
  extra?: () => JSX.Element;
};

type ServerSettingsModalProps = {
  onApplyVaultSettings?: () => void;
};

type AppSettingsModalProps = {
  onApplyAppSettings?: () => void;
};

function renderField<Model extends Record<string, unknown>>(
  entry: FieldEntry<Model>,
  current: () => Model,
  scope: string,
  onInput: <K extends keyof Model>(key: K, value: string) => void,
  onToggle: <K extends keyof Model>(key: K, checked: boolean) => void,
  onSave: () => void,
): JSX.Element {
  const [key, field] = entry;

  if (field.kind === "checkbox") {
    return (
      <label class="settings-row">
        <span>{field.label}</span>
        <input
          type="checkbox"
          data-key={String(key)}
          data-scope={scope}
          checked={Boolean(current()[key])}
          onChange={(e) => onToggle(key, e.currentTarget.checked)}
        />
      </label>
    );
  }

  if (field.kind === "select") {
    return (
      <label class="settings-row">
        <span>{field.label}</span>
        <select
          data-key={String(key)}
          data-scope={scope}
          value={String(current()[key])}
          onChange={(e) => onInput(key, e.currentTarget.value)}
        >
          <For each={field.options ?? []}>
            {(option) => <option value={String(option.value)}>{option.label}</option>}
          </For>
        </select>
      </label>
    );
  }

  if (field.kind === "range") {
    return (
      <label class="settings-row">
        <span>{field.label}</span>
        <input
          type="range"
          data-key={String(key)}
          data-scope={scope}
          min={field.min}
          max={field.max}
          step={field.step}
          value={String(current()[key])}
          onInput={(e) => onInput(key, e.currentTarget.value)}
        />
        <span class="slider-value">
          {field.format ? field.format(current()[key]) : String(current()[key])}
        </span>
      </label>
    );
  }

  return (
    <>
      <Show when={field.hint}>{(hint) => <p class="settings-hint">{hint()}</p>}</Show>
      <label class={field.kind === "text" ? "settings-text" : "settings-row"}>
        <Show when={field.kind !== "text"}>
          <span>{field.label}</span>
        </Show>
        <input
          type={field.kind}
          data-key={String(key)}
          data-scope={scope}
          class={field.kind === "text" ? "settings-text" : undefined}
          value={field.format ? field.format(current()[key]) : String(current()[key])}
          placeholder={field.placeholder}
          min={field.min}
          max={field.max}
          step={field.step}
          onInput={(e) => onInput(key, e.currentTarget.value)}
          onKeyDown={(e) => {
            if (field.saveOnEnter && e.key === "Enter") {
              e.preventDefault();
              onSave();
            }
          }}
        />
      </label>
    </>
  );
}

function renderSection<Model extends Record<string, unknown>, TSection extends SectionId>(
  current: () => Model,
  sectionId: TSection,
  registry: FieldRegistry<Model>,
  scope: string,
  onInput: <K extends keyof Model>(key: K, value: string) => void,
  onToggle: <K extends keyof Model>(key: K, checked: boolean) => void,
  onSave: () => void,
): JSX.Element {
  const fields = getFieldEntries(registry).filter(([, field]) => field.section === sectionId);
  return (
    <For each={fields}>
      {(entry) => renderField(entry, current, scope, onInput, onToggle, onSave)}
    </For>
  );
}

function SettingsSectionsView<Model extends Record<string, unknown>, TSection extends SectionId>(
  props: Readonly<SettingsSectionsViewProps<Model, TSection>>,
) {
  return (
    <Show
      when={props.current()}
      fallback={
        <p style={{ padding: "1rem", color: "var(--fg-muted)", "font-size": "13px" }}>Loading...</p>
      }
    >
      {(current) => (
        <>
          <h2>{props.title}</h2>
          <For each={props.sections}>
            {(section) => (
              <div class="settings-section">
                <h3>{section.title}</h3>
                {renderSection(
                  current,
                  section.id,
                  props.registry,
                  props.scope,
                  props.onInput,
                  props.onToggle,
                  props.onSave,
                )}
              </div>
            )}
          </For>
          <Show when={props.extra}>{(extra) => extra()()}</Show>
          <div class="settings-actions">
            <button id={props.saveId} onClick={props.onSave}>
              Save
            </button>
            <button id={props.cancelId} onClick={props.onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </Show>
  );
}

function ServerSecuritySection(
  props: Readonly<{
    status: () => AppStatus | null;
    securityStatus: () => string;
    onRemovePrf: (id: string) => void;
    onAddPrf: () => void;
    onLock: () => void;
  }>,
) {
  return (
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
                  <button class="prf-remove" data-id={id} onClick={() => props.onRemovePrf(id)}>
                    Remove
                  </button>
                </div>
              )}
            </For>
          </>
        </Show>
        <Show
          when={isPrfLikelySupported()}
          fallback={<p class="settings-hint">WebAuthn PRF not available in this browser.</p>}
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
  );
}

export function SettingsModal() {
  const [current, setCurrent] = createSignal<Settings | null>(null);
  const [status, setStatus] = createSignal<AppStatus | null>(null);
  const [securityStatus, setSecurityStatus] = createSignal("");

  function close() {
    uiStore.closeSettings();
  }

  async function open() {
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

  function updateServerSetting<K extends keyof Settings>(key: K, rawValue: string) {
    setCurrent((prev) =>
      prev
        ? updateObjectField(prev, key, parseStringField(SERVER_SETTING_FIELDS, key, rawValue))
        : prev,
    );
  }

  function toggleServerSetting<K extends keyof Settings>(key: K, checked: boolean) {
    setCurrent((prev) =>
      prev
        ? updateObjectField(prev, key, parseCheckboxField(SERVER_SETTING_FIELDS, key, checked))
        : prev,
    );
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
    <Show when={modal.shouldRender()}>
      <OverlayFrame id="settings-overlay" isOpen={modal.isOpen()} onClose={modal.close}>
        <div
          id="settings-panel"
          class="settings-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Server settings"
        >
          <SettingsSectionsView<Settings, ServerSectionId>
            title="Server settings"
            current={current}
            sections={SERVER_SETTINGS_SECTION_ORDER}
            registry={SERVER_SETTING_FIELDS}
            scope="server-setting"
            saveId="settings-save"
            cancelId="settings-cancel"
            onInput={updateServerSetting}
            onToggle={toggleServerSetting}
            onSave={() => {
              void save();
            }}
            onClose={close}
            extra={() => (
              <ServerSecuritySection
                status={status}
                securityStatus={securityStatus}
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
            )}
          />
        </div>
      </OverlayFrame>
    </Show>
  );
}

export function VaultSettingsModal(props: Readonly<ServerSettingsModalProps> = {}) {
  const [current, setCurrent] = createSignal<VaultSettings | null>(null);

  function close() {
    uiStore.closeVaultSettings();
  }

  function open() {
    setCurrent(getVaultSettings());
  }

  function save() {
    const snapshot = current();
    if (!snapshot) {
      return;
    }
    const updated: VaultSettings = {
      ...snapshot,
      formatToolbarHeadingLevels: [...snapshot.formatToolbarHeadingLevels],
    };
    saveVaultSettings(updated);
    props.onApplyVaultSettings?.();
    setCurrent(updated);
    close();
  }

  function updateVaultSetting<K extends keyof VaultSettings>(key: K, rawValue: string) {
    const nextValue = parseStringField(VAULT_SETTING_FIELDS, key, rawValue);
    if (typeof nextValue === "number" && Number.isNaN(nextValue)) {
      return;
    }
    setCurrent((prev) => (prev ? updateObjectField(prev, key, nextValue) : prev));
  }

  function toggleVaultSetting<K extends keyof VaultSettings>(key: K, checked: boolean) {
    setCurrent((prev) =>
      prev
        ? updateObjectField(prev, key, parseCheckboxField(VAULT_SETTING_FIELDS, key, checked))
        : prev,
    );
  }

  const modal = createManagedModal({
    id: "vault-settings",
    isRequestedOpen: uiStore.isVaultSettingsRequestedOpen,
    onOpen: open,
    onClose: close,
  });

  return (
    <Show when={modal.shouldRender()}>
      <OverlayFrame id="vault-settings-overlay" isOpen={modal.isOpen()} onClose={modal.close}>
        <div
          id="vault-settings-panel"
          class="settings-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Vault settings"
        >
          <SettingsSectionsView<VaultSettings, VaultSectionId>
            title="Vault settings"
            current={current}
            sections={VAULT_SETTINGS_SECTION_ORDER}
            registry={VAULT_SETTING_FIELDS}
            scope="vault-setting"
            saveId="vault-settings-save"
            cancelId="vault-settings-cancel"
            onInput={updateVaultSetting}
            onToggle={toggleVaultSetting}
            onSave={save}
            onClose={close}
          />
        </div>
      </OverlayFrame>
    </Show>
  );
}

export function AppSettingsModal(props: Readonly<AppSettingsModalProps> = {}) {
  const [current, setCurrent] = createSignal<AppSettings | null>(null);

  function close() {
    uiStore.closeAppSettings();
  }

  function open() {
    setCurrent(getAppSettings());
  }

  function save() {
    const snapshot = current();
    if (!snapshot) {
      return;
    }
    saveAppSettings(snapshot);
    props.onApplyAppSettings?.();
    setCurrent(snapshot);
    close();
  }

  function updateAppSetting<K extends keyof AppSettings>(key: K, rawValue: string) {
    const nextValue = parseStringField(APP_SETTING_FIELDS, key, rawValue);
    if (typeof nextValue === "number" && Number.isNaN(nextValue)) {
      return;
    }
    setCurrent((prev) => (prev ? updateObjectField(prev, key, nextValue) : prev));
  }

  function toggleAppSetting<K extends keyof AppSettings>(key: K, checked: boolean) {
    setCurrent((prev) =>
      prev
        ? updateObjectField(prev, key, parseCheckboxField(APP_SETTING_FIELDS, key, checked))
        : prev,
    );
  }

  const modal = createManagedModal({
    id: "app-settings",
    isRequestedOpen: uiStore.isAppSettingsRequestedOpen,
    onOpen: open,
    onClose: close,
  });

  return (
    <Show when={modal.shouldRender()}>
      <OverlayFrame id="app-settings-overlay" isOpen={modal.isOpen()} onClose={modal.close}>
        <div
          id="app-settings-panel"
          class="settings-modal"
          role="dialog"
          aria-modal="true"
          aria-label="App settings"
        >
          <SettingsSectionsView<AppSettings, AppSectionId>
            title="App settings"
            current={current}
            sections={APP_SETTINGS_SECTION_ORDER}
            registry={APP_SETTING_FIELDS}
            scope="app-setting"
            saveId="app-settings-save"
            cancelId="app-settings-cancel"
            onInput={updateAppSetting}
            onToggle={toggleAppSetting}
            onSave={save}
            onClose={close}
          />
        </div>
      </OverlayFrame>
    </Show>
  );
}
