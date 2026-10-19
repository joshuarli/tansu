import type { AppSettings, AppVaultSettings, V2AppSettingsResponse } from "./types.generated.ts";

const form = document.querySelector<HTMLFormElement>("#settings-form");
const vaults = document.querySelector<HTMLElement>("#vaults");
const status = document.querySelector<HTMLElement>("#status");
if (!form || !vaults || !status) throw new Error("setup form is unavailable");

function addVault(value: AppVaultSettings = { name: "", path: "" }): void {
  const row = document.createElement("div");
  row.className = "vault";
  row.innerHTML = `<label>Name<input name="vaultName" required value=""></label><label>Folder path<input name="vaultPath" required value=""></label><button type="button" aria-label="Remove vault">Remove</button>`;
  row.querySelector<HTMLInputElement>("[name=vaultName]")!.value = value.name;
  row.querySelector<HTMLInputElement>("[name=vaultPath]")!.value = value.path;
  row.querySelector("button")!.addEventListener("click", () => row.remove());
  vaults!.append(row);
}

document.querySelector("#add-vault")!.addEventListener("click", () => addVault());

const initial = await fetch("/api/v2/app/settings").then(async (response) => {
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<V2AppSettingsResponse>;
});
for (const vault of initial.settings?.vaults ?? []) addVault(vault);
if (vaults.childElementCount === 0) addVault();
if (initial.settings?.auth) {
  (form.elements.namedItem("externalOrigin") as HTMLInputElement).value = initial.settings.auth.externalOrigin;
  (form.elements.namedItem("rpId") as HTMLInputElement).value = initial.settings.auth.rpId;
  (form.elements.namedItem("rpName") as HTMLInputElement).value = initial.settings.auth.rpName;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "Saving…";
  const values = [...vaults.querySelectorAll<HTMLElement>(".vault")].map((row) => ({
    name: row.querySelector<HTMLInputElement>("[name=vaultName]")!.value.trim(),
    path: row.querySelector<HTMLInputElement>("[name=vaultPath]")!.value.trim(),
  }));
  const externalOrigin = (form.elements.namedItem("externalOrigin") as HTMLInputElement).value.trim();
  const rpId = (form.elements.namedItem("rpId") as HTMLInputElement).value.trim();
  const rpName = (form.elements.namedItem("rpName") as HTMLInputElement).value.trim();
  const authFields = [externalOrigin, rpId, rpName];
  if (authFields.some(Boolean) && authFields.some((value) => !value)) {
    status.textContent = "Fill in all authentication fields or leave them blank.";
    return;
  }
  const settings: AppSettings = {
    vaults: values,
    auth: authFields.every(Boolean) ? { externalOrigin, rpId, rpName } : null,
  };
  try {
    const csrfCookie = document.cookie.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("__Host-tansu_csrf="));
    const headers = new Headers({ "Content-Type": "application/json" });
    if (csrfCookie) {
      headers.set("X-Tansu-CSRF", decodeURIComponent(csrfCookie.slice("__Host-tansu_csrf=".length)));
    }
    const response = await fetch("/api/v2/app/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify(settings),
    });
    if (!response.ok) throw new Error(await response.text());
    status.textContent = "Settings saved. Restart Tansu to open your vaults.";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
});
