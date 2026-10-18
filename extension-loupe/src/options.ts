import { Schema } from "effect";
import { normalizeTansuOrigin, TansuSettingsSchema } from "./tansu-schemas.ts";
import { readTansuSettings } from "./tansu-settings.ts";

const urlInput = requiredElement<HTMLInputElement>("#tansu-url"),
  statusElement = requiredElement<HTMLDivElement>("#status"),
  saveButton = requiredElement<HTMLButtonElement>("#save");

try {
  const settings = await readTansuSettings(chrome.storage.local);
  urlInput.value = settings.tansuOrigin ?? "";
} catch {
  setStatus("Could not read the saved Tansu URL.", true);
}

saveButton.addEventListener("click", () => void saveTansuUrl());

async function saveTansuUrl(): Promise<void> {
  const tansuOrigin = normalizeTansuOrigin(urlInput.value);
  if (tansuOrigin === undefined) {
    setStatus("Enter an http or https URL.", true);
    return;
  }
  saveButton.disabled = true;
  try {
    await chrome.storage.local.set(Schema.decodeUnknownSync(TansuSettingsSchema)({ tansuOrigin }));
    urlInput.value = tansuOrigin;
    setStatus("Saved.");
  } catch (error) {
    console.error("Loupe settings error:", error);
    setStatus("Could not save the Tansu URL.", true);
  } finally {
    saveButton.disabled = false;
  }
}

function setStatus(message: string, isError = false): void {
  statusElement.textContent = message;
  statusElement.className = isError ? "error" : "";
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Options markup is missing ${selector}.`);
  return element;
}
