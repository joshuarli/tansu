import { describe, expect, it, vi } from "vitest";

import {
  PARTIAL_AUTH_MESSAGE,
  SAVED_MESSAGE,
  addVaultRow,
  bootSetup,
  buildSettings,
  csrfToken,
  querySetupElements,
  saveSetup,
  type SetupElements,
} from "./setup.ts";

function mountSetup(): SetupElements {
  document.body.innerHTML = `
    <form id="settings-form">
      <section id="vaults" aria-label="Vaults"></section>
      <button id="add-vault" type="button">Add vault</button>
      <label>External origin <input name="externalOrigin" /></label>
      <label>Relying party ID <input name="rpId" /></label>
      <label>Relying party name <input name="rpName" /></label>
      <button type="submit">Save settings</button>
    </form>
    <p id="status" role="status"></p>`;
  const elements = querySetupElements();
  if (elements === null) throw new Error("setup fixture did not mount");
  return elements;
}

function stubFetch(handler: (url: string, init?: RequestInit) => unknown): typeof fetch {
  return vi.fn(async (url: unknown, init?: unknown) =>
    handler(String(url), init as RequestInit)) as unknown as typeof fetch;
}

function okJson(payload: unknown): unknown {
  return { ok: true, json: async () => payload, text: async () => "" };
}

function vaultInputs(elements: SetupElements): { name: string; path: string }[] {
  return [...elements.vaults.querySelectorAll<HTMLElement>(".vault")].map((row) => ({
    name: row.querySelector<HTMLInputElement>("[name=vaultName]")!.value,
    path: row.querySelector<HTMLInputElement>("[name=vaultPath]")!.value,
  }));
}

describe("setup settings", () => {
  it("builds trimmed settings with null auth when blank", () => {
    expect(buildSettings(
      [{ name: "  One ", path: " vault/ " }],
      { externalOrigin: "", rpId: "", rpName: "" },
    )).toStrictEqual({ vaults: [{ name: "One", path: "vault/" }], auth: null });
  });

  it("keeps full auth and rejects partial auth", () => {
    expect(buildSettings(
      [],
      { externalOrigin: " https://notes.example.com ", rpId: " notes.example.com ", rpName: " Tansu " },
    )).toStrictEqual({
      vaults: [],
      auth: { externalOrigin: "https://notes.example.com", rpId: "notes.example.com", rpName: "Tansu" },
    });
    expect(() => buildSettings(
      [],
      { externalOrigin: "https://notes.example.com", rpId: "", rpName: "" },
    )).toThrow(PARTIAL_AUTH_MESSAGE);
  });

  it("parses the CSRF cookie", () => {
    expect(csrfToken("other=1; __Host-tansu_csrf=tok%2F123; third=2")).toBe("tok/123");
    expect(csrfToken("other=1")).toBeUndefined();
  });

  it("leaves pages without the setup form alone", () => {
    document.body.innerHTML = "";
    expect(querySetupElements()).toBeNull();
  });
});

describe("setup page", () => {
  it("fills vault rows and auth fields from stored settings", async () => {
    const elements = mountSetup();
    const fetch = stubFetch(() => okJson({
      settings: {
        vaults: [{ name: "One", path: "/vaults/one" }],
        auth: { externalOrigin: "https://notes.example.com", rpId: "notes.example.com", rpName: "Tansu" },
      },
    }));
    await bootSetup(elements, fetch);
    expect(vaultInputs(elements)).toStrictEqual([{ name: "One", path: "/vaults/one" }]);
    expect(elements.form.elements.namedItem("rpId")).toHaveProperty("value", "notes.example.com");
  });

  it("starts with one blank vault row when nothing is stored", async () => {
    const elements = mountSetup();
    await bootSetup(elements, stubFetch(() => okJson({ settings: null })));
    expect(vaultInputs(elements)).toStrictEqual([{ name: "", path: "" }]);
  });

  it("saves trimmed settings with the CSRF token", async () => {
    const elements = mountSetup();
    addVaultRow(elements.vaults);
    const row = elements.vaults.querySelector<HTMLElement>(".vault")!;
    row.querySelector<HTMLInputElement>("[name=vaultName]")!.value = "  One ";
    row.querySelector<HTMLInputElement>("[name=vaultPath]")!.value = " /vaults/one ";
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fetch = stubFetch((url, init) => {
      seen.push({ url, init });
      return okJson({});
    });
    const pending = saveSetup(elements, fetch, "other=1; __Host-tansu_csrf=tok%2F123");
    expect(elements.status.textContent).toBe("Saving…");
    await pending;
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/api/v2/app/settings");
    expect(seen[0]!.init?.method).toBe("PUT");
    expect(JSON.parse(String(seen[0]!.init?.body))).toStrictEqual({
      vaults: [{ name: "One", path: "/vaults/one" }],
      auth: null,
    });
    expect(new Headers(seen[0]!.init?.headers).get("X-Tansu-CSRF")).toBe("tok/123");
    expect(elements.status.textContent).toBe(SAVED_MESSAGE);
  });

  it("blocks submit on partial auth without a save request", async () => {
    const elements = mountSetup();
    const fetch = stubFetch(() => okJson({ settings: null }));
    await bootSetup(elements, fetch);
    (elements.form.elements.namedItem("rpId") as HTMLInputElement).value = "notes.example.com";
    elements.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(elements.status.textContent).toBe(PARTIAL_AUTH_MESSAGE);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
