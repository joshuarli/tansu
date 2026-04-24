import { setupDOM } from "./test-helper.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("input-dialog", () => {
  let cleanup: () => void;
  let showInputDialog: (placeholder: string, defaultValue?: string) => Promise<string | null>;

  beforeAll(async () => {
    cleanup = setupDOM();
    const mod = await import("./input-dialog.ts");
    ({ showInputDialog } = mod);
  });

  afterAll(() => {
    cleanup();
  });

  function getOverlay() {
    return document.querySelector("#input-dialog-overlay")!;
  }

  function getInput() {
    return document.querySelector("#input-dialog-input") as HTMLInputElement;
  }

  it("Enter key submits the dialog and resolves with trimmed value", async () => {
    const p = showInputDialog("Type something...");
    await tick();

    expect(getOverlay().classList.contains("hidden")).toBeFalsy();
    getInput().value = "  hello  ";
    getInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );

    const result = await p;
    expect(result).toBe("hello");
    expect(getOverlay().classList.contains("hidden")).toBeTruthy();
  });

  it("Escape key cancels and resolves with null", async () => {
    const p = showInputDialog("Type something...", "default");
    await tick();

    expect(getOverlay().classList.contains("hidden")).toBeFalsy();
    expect(getInput().value).toBe("default");
    getInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    const result = await p;
    expect(result).toBeNull();
    expect(getOverlay().classList.contains("hidden")).toBeTruthy();
  });

  it("backdrop click cancels and resolves with null", async () => {
    const p = showInputDialog("Type something...");
    await tick();

    expect(getOverlay().classList.contains("hidden")).toBeFalsy();
    // Click the overlay itself (not the inner dialog)
    getOverlay().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    const result = await p;
    expect(result).toBeNull();
    expect(getOverlay().classList.contains("hidden")).toBeTruthy();
  });

  it("empty input resolves with null", async () => {
    const p = showInputDialog("Type something...");
    await tick();

    getInput().value = "   ";
    getInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );

    const result = await p;
    expect(result).toBeNull();
  });

  it("opening dialog while one is in-flight cancels the previous", async () => {
    const p1 = showInputDialog("First");
    await tick();

    // Open second before first resolves
    const p2 = showInputDialog("Second");
    await tick();

    // First should have resolved null
    const r1 = await p1;
    expect(r1).toBeNull();

    // Second is still open; cancel it
    getInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    const r2 = await p2;
    expect(r2).toBeNull();
  });
});
