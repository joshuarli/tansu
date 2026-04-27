import { setupDOM, mockFetch } from "./test-helper.ts";

describe("vault-switcher", () => {
  let cleanup: () => void;
  let mock: ReturnType<typeof mockFetch>;
  let initVaultSwitcher: typeof import("./vault-switcher.ts").initVaultSwitcher;
  let refreshVaultSwitcher: typeof import("./vault-switcher.ts").refreshVaultSwitcher;

  beforeAll(async () => {
    cleanup = setupDOM();
    mock = mockFetch();
    mock.on("GET", "/api/state", { tabs: [], active: -1 });
    mock.on("PUT", "/api/state", {});
    mock.on("POST", /\/api\/vaults\/\d+\/activate/, {});
    const mod = await import("./vault-switcher.ts");
    ({ initVaultSwitcher, refreshVaultSwitcher } = mod);
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

    await initVaultSwitcher();

    expect(getContainer().textContent).toBe("");
    expect(document.querySelector("#vault-select")).toBeNull();
  });

  it("renders a select when multiple vaults exist", async () => {
    mock.on("GET", "/api/vaults", [
      { index: 0, name: "personal", active: true, encrypted: false, locked: false },
      { index: 1, name: "work", active: false, encrypted: true, locked: true },
    ]);

    await refreshVaultSwitcher();

    const select = document.querySelector("#vault-select") as HTMLSelectElement | null;
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
    await refreshVaultSwitcher();

    const select = document.querySelector("#vault-select") as HTMLSelectElement;
    select.value = "1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    const refreshedSelect = document.querySelector("#vault-select") as HTMLSelectElement;
    expect(refreshedSelect.value).toBe("0");
    globalThis.confirm = originalConfirm;
    closeAllTabs();
  });

  it("successful switch refreshes vault list and emits events", async () => {
    mock.on("GET", "/api/note", { content: "# Two", mtime: 1000, tags: [] });
    mock.on("GET", "/api/vaults", [
      { index: 0, name: "personal", active: true, encrypted: false, locked: false },
      { index: 1, name: "work", active: false, encrypted: true, locked: false },
    ]);
    await refreshVaultSwitcher();
    mock.on("GET", "/api/vaults", [
      { index: 0, name: "personal", active: false, encrypted: false, locked: false },
      { index: 1, name: "work", active: true, encrypted: true, locked: false },
    ]);

    const { on } = await import("./events.ts");
    let switched = 0;
    let filesChanged = 0;
    const offSwitched = on("vault:switched", () => {
      switched += 1;
    });
    const offFilesChanged = on("files:changed", () => {
      filesChanged += 1;
    });

    const select = document.querySelector("#vault-select") as HTMLSelectElement;
    select.value = "1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));

    const refreshedSelect = document.querySelector("#vault-select") as HTMLSelectElement;
    expect(refreshedSelect.value).toBe("1");
    expect(switched).toBe(1);
    expect(filesChanged).toBe(1);

    offSwitched();
    offFilesChanged();
  });
});
