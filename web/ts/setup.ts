import type { AppSettings, AppVaultSettings, V2AppSettingsResponse } from "./types.generated.ts";

export const PARTIAL_AUTH_MESSAGE = "Fill in all authentication fields or leave them blank.";
export const SAVED_MESSAGE = "Settings saved. Restart Tansu to open your vaults.";
const SAVING_MESSAGE = "Saving…";
const CSRF_COOKIE = "__Host-tansu_csrf=";

export type VaultDraft = { name: string; path: string };
export type AuthDraft = { externalOrigin: string; rpId: string; rpName: string };

export function trimVault(vault: VaultDraft): AppVaultSettings {
  return { name: vault.name.trim(), path: vault.path.trim() };
}

export function authSettings(auth: AuthDraft): AppSettings["auth"] {
  const trimmed = {
    externalOrigin: auth.externalOrigin.trim(),
    rpId: auth.rpId.trim(),
    rpName: auth.rpName.trim(),
  };
  const fields = [trimmed.externalOrigin, trimmed.rpId, trimmed.rpName];
  if (fields.every((value) => value === "")) return null;
  if (fields.some((value) => value === "")) throw new Error(PARTIAL_AUTH_MESSAGE);
  return trimmed;
}

export function buildSettings(vaults: VaultDraft[], auth: AuthDraft): AppSettings {
  return { vaults: vaults.map(trimVault), auth: authSettings(auth) };
}

export function csrfToken(cookieHeader: string): string | undefined {
  const match = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(CSRF_COOKIE));
  return match === undefined ? undefined : decodeURIComponent(match.slice(CSRF_COOKIE.length));
}

export type SetupElements = {
  form: HTMLFormElement;
  vaults: HTMLElement;
  status: HTMLElement;
};

export function querySetupElements(root: ParentNode = document): SetupElements | null {
  const form = root.querySelector<HTMLFormElement>("#settings-form");
  const vaults = root.querySelector<HTMLElement>("#vaults");
  const status = root.querySelector<HTMLElement>("#status");
  if (form === null || vaults === null || status === null) return null;
  return { form, vaults, status };
}

export function addVaultRow(vaults: HTMLElement, value: AppVaultSettings = { name: "", path: "" }): void {
  const row = document.createElement("div");
  row.className = "vault";
  row.innerHTML = `<label>Name<input name="vaultName" required value=""></label><label>Folder path<input name="vaultPath" required value=""></label><button type="button" aria-label="Remove vault">Remove</button>`;
  row.querySelector<HTMLInputElement>("[name=vaultName]")!.value = value.name;
  row.querySelector<HTMLInputElement>("[name=vaultPath]")!.value = value.path;
  row.querySelector("button")!.addEventListener("click", () => row.remove());
  vaults.append(row);
}

export function readVaultRows(vaults: HTMLElement): VaultDraft[] {
  return [...vaults.querySelectorAll<HTMLElement>(".vault")].map((row) => ({
    name: row.querySelector<HTMLInputElement>("[name=vaultName]")?.value ?? "",
    path: row.querySelector<HTMLInputElement>("[name=vaultPath]")?.value ?? "",
  }));
}

export function readAuthFields(form: HTMLFormElement): AuthDraft {
  const field = (name: string): string => (form.elements.namedItem(name) as HTMLInputElement).value;
  return { externalOrigin: field("externalOrigin"), rpId: field("rpId"), rpName: field("rpName") };
}

export function fillSetupForm(elements: SetupElements, settings: AppSettings | null | undefined): void {
  for (const vault of settings?.vaults ?? []) addVaultRow(elements.vaults, vault);
  if (elements.vaults.childElementCount === 0) addVaultRow(elements.vaults);
  if (settings?.auth) {
    const auth = settings.auth;
    (elements.form.elements.namedItem("externalOrigin") as HTMLInputElement).value = auth.externalOrigin;
    (elements.form.elements.namedItem("rpId") as HTMLInputElement).value = auth.rpId;
    (elements.form.elements.namedItem("rpName") as HTMLInputElement).value = auth.rpName;
  }
}

export async function saveSetup(
  elements: SetupElements,
  fetchImpl: typeof fetch = fetch,
  cookieHeader: string = document.cookie,
): Promise<void> {
  elements.status.textContent = SAVING_MESSAGE;
  let settings: AppSettings;
  try {
    settings = buildSettings(readVaultRows(elements.vaults), readAuthFields(elements.form));
  } catch (error) {
    elements.status.textContent = error instanceof Error ? error.message : String(error);
    return;
  }
  try {
    const headers = new Headers({ "Content-Type": "application/json" });
    const token = csrfToken(cookieHeader);
    if (token !== undefined) {
      headers.set("X-Tansu-CSRF", token);
    }
    const response = await fetchImpl("/api/v2/app/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify(settings),
    });
    if (!response.ok) throw new Error(await response.text());
    elements.status.textContent = SAVED_MESSAGE;
  } catch (error) {
    elements.status.textContent = error instanceof Error ? error.message : String(error);
  }
}

export async function bootSetup(
  elements: SetupElements,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  document.querySelector("#add-vault")?.addEventListener("click", () => addVaultRow(elements.vaults));
  const initial = await fetchImpl("/api/v2/app/settings").then(async (response) => {
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<V2AppSettingsResponse>;
  });
  fillSetupForm(elements, initial.settings);
  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveSetup(elements, fetchImpl);
  });
}

const elements = querySetupElements();
if (elements !== null) {
  await bootSetup(elements);
}
