import { createModalManager } from "./modal-manager.ts";
import { setupDOM } from "./test-helper.ts";

describe("modal-manager", () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = setupDOM();
  });

  afterEach(() => {
    cleanup();
  });

  it("replace dismisses the previous exclusive modal", () => {
    const manager = createModalManager();
    const dismissed: string[] = [];

    manager.replace("search", () => {
      dismissed.push("search");
    });
    expect(manager.activeModal()).toBe("search");

    manager.replace("settings", () => {
      dismissed.push("settings");
    });

    expect(dismissed).toStrictEqual(["search"]);
    expect(manager.activeModal()).toBe("settings");
    expect(manager.has("search")).toBeFalsy();
    expect(manager.has("settings")).toBeTruthy();
  });

  it("stacked dialogs restore the parent modal and focus", () => {
    const manager = createModalManager();
    const opener = document.createElement("button");
    opener.id = "opener";
    document.body.append(opener);
    opener.focus();

    manager.replace("settings");
    expect(manager.activeModal()).toBe("settings");

    const dialogButton = document.createElement("button");
    dialogButton.id = "dialog-button";
    document.body.append(dialogButton);
    dialogButton.focus();

    manager.push("input-dialog");
    expect(manager.activeModal()).toBe("input-dialog");

    manager.closeTop();

    expect(manager.activeModal()).toBe("settings");
    expect(document.activeElement).toBe(dialogButton);
  });

  it("closeTop restores focus to the captured opener for a single modal", () => {
    const manager = createModalManager();
    const opener = document.createElement("button");
    opener.id = "single-opener";
    document.body.append(opener);
    opener.focus();

    manager.replace("palette");
    expect(manager.activeModal()).toBe("palette");

    const other = document.createElement("button");
    document.body.append(other);
    other.focus();

    manager.closeTop();

    expect(manager.activeModal()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("replacing while a stacked dialog is open dismisses the stack from top to bottom", () => {
    const manager = createModalManager();
    const dismissed: string[] = [];

    manager.replace("settings", () => {
      dismissed.push("settings");
    });
    manager.push("alert-dialog", () => {
      dismissed.push("alert-dialog");
    });

    manager.replace("search", () => {
      dismissed.push("search");
    });

    expect(dismissed).toStrictEqual(["alert-dialog", "settings"]);
    expect(manager.activeModal()).toBe("search");
    expect(manager.has("settings")).toBeFalsy();
    expect(manager.has("alert-dialog")).toBeFalsy();
  });
});
