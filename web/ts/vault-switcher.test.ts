import { render } from "solid-js/web";

import { serverStore } from "./server-store.ts";
import { setupDOM, mockFetch } from "./test-helper.ts";
import { VaultSwitcher } from "./vault-switcher.tsx";

describe("vault-switcher", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;

  beforeAll(async () => {
    cleanup = setupDOM();
    const { delegateEvents } = await import("solid-js/web");
    delegateEvents(["click", "input", "change", "keydown", "contextmenu", "auxclick"]);
    mock = mockFetch();
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
    mock.on("PUT", "/api/state", {});
    mock.on("POST", /\/api\/vaults\/\d+\/activate/, {});
    render(() => VaultSwitcher(), document.querySelector("#vault-switcher") as HTMLElement);
  });

  afterAll(() => {
    mock.restore();
    cleanup();
  });

  function getContainer() {
    return document.querySelector("#vault-switcher") as HTMLElement;
  }

  it("renders nothing when only one vault exists", async () => {
    mock.on("GET", "/api/vaults", [
      { index: 0, name: "personal", active: true, encrypted: false, locked: false },
    ]);
    serverStore.handleVaultSwitched();
    await new Promise((r) => setTimeout(r, 20));

    expect(getContainer().textContent).toBe("");
    expect(document.querySelector(".vault-select")).toBeNull();
  });

  it("renders a select when multiple vaults exist", async () => {
    mock.on("GET", "/api/vaults", [
      { index: 0, name: "personal", active: true, encrypted: false, locked: false },
      { index: 1, name: "work", active: false, encrypted: true, locked: true },
    ]);

    await serverStore.handleVaultSwitched();
    await new Promise((r) => setTimeout(r, 20));

    const select = document.querySelector(".vault-select") as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(select!.options).toHaveLength(2);
    expect(select!.options[0]!.selected).toBeTruthy();
    expect(select!.options[1]!.textContent).toContain("🔒");
  });

  it("cancelled dirty switch resets the select to the active vault", async () => {
    const originalConfirm = globalThis.confirm;
    globalThis.confirm = () => false;
    mock.on("GET", "/api/note", { content: "# One", mtime: 1000, tags: [] });
    mock.on("GET", "/api/vaults", [
      { index: 0, name: "personal", active: true, encrypted: false, locked: false },
      { index: 1, name: "work", active: false, encrypted: true, locked: true },
    ]);

    const { openTab, markDirty, closeAllTabs } = await import("./tab-state.ts");
    closeAllTabs();
    await openTab("one.md");
    markDirty("one.md");
    await serverStore.handleVaultSwitched();
    await new Promise((r) => setTimeout(r, 20));

    const select = document.querySelector(".vault-select") as HTMLSelectElement;
    select.value = "1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    const refreshedSelect = document.querySelector(".vault-select") as HTMLSelectElement;
    expect(refreshedSelect.value).toBe("0");
    globalThis.confirm = originalConfirm;
    closeAllTabs();
  });
});
