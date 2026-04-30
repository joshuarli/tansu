import type { showContextMenu as ShowContextMenu } from "./context-menu.ts";
import { setupDOM } from "./test-helper.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("context-menu", () => {
  let cleanup: () => void;
  let showContextMenu: typeof ShowContextMenu;

  beforeAll(async () => {
    cleanup = setupDOM();
    ({ showContextMenu } = await import("./context-menu.ts"));
  });

  afterAll(() => {
    cleanup();
  });

  it("renders at the requested coordinates", () => {
    showContextMenu([{ label: "Rename", onclick: () => {} }], 120, 240);

    const menu = document.querySelector(".context-menu") as HTMLElement | null;
    expect(menu).not.toBeNull();
    expect(menu!.style.left).toBe("120px");
    expect(menu!.style.top).toBe("240px");
  });

  it("applies the danger class to danger items", () => {
    showContextMenu([{ label: "Delete", danger: true, onclick: () => {} }], 0, 0);

    const item = document.querySelector(".context-menu-item") as HTMLElement | null;
    expect(item).not.toBeNull();
    expect(item!.classList.contains("danger")).toBeTruthy();
  });

  it("outside click dismisses the active menu", async () => {
    showContextMenu([{ label: "Rename", onclick: () => {} }], 10, 10);
    await tick();

    expect(document.querySelector(".context-menu")).not.toBeNull();
    document.body.click();
    expect(document.querySelector(".context-menu")).toBeNull();
  });

  it("showing a second menu replaces the first", () => {
    showContextMenu([{ label: "First", onclick: () => {} }], 1, 1);
    showContextMenu([{ label: "Second", onclick: () => {} }], 2, 2);

    const menus = document.querySelectorAll(".context-menu");
    expect(menus).toHaveLength(1);
    expect(menus[0]!.textContent).toBe("Second");
  });

  it("item actions are deferred until after the menu is removed", async () => {
    let sawMenuDuringAction = true;
    showContextMenu(
      [
        {
          label: "Rename",
          onclick: () => {
            sawMenuDuringAction = document.querySelector(".context-menu") !== null;
          },
        },
      ],
      0,
      0,
    );

    (document.querySelector(".context-menu-item") as HTMLElement).click();
    expect(document.querySelector(".context-menu")).toBeNull();
    await tick();
    expect(sawMenuDuringAction).toBeFalsy();
  });

  describe("keyboard navigation", () => {
    it("focuses the first item on open", () => {
      showContextMenu(
        [
          { label: "One", onclick: () => {} },
          { label: "Two", onclick: () => {} },
        ],
        0,
        0,
      );
      const items = document.querySelectorAll(".context-menu-item");
      expect(document.activeElement).toBe(items[0]);
    });

    it("ArrowDown moves focus to the next item", () => {
      showContextMenu(
        [
          { label: "One", onclick: () => {} },
          { label: "Two", onclick: () => {} },
        ],
        0,
        0,
      );
      const items = document.querySelectorAll(".context-menu-item");
      (items[0] as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
      expect(document.activeElement).toBe(items[1]);
    });

    it("ArrowDown wraps from last item to first", () => {
      showContextMenu(
        [
          { label: "One", onclick: () => {} },
          { label: "Two", onclick: () => {} },
        ],
        0,
        0,
      );
      const items = document.querySelectorAll(".context-menu-item");
      (items[0] as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
      (items[1] as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
      expect(document.activeElement).toBe(items[0]);
    });

    it("ArrowUp wraps from first item to last", () => {
      showContextMenu(
        [
          { label: "One", onclick: () => {} },
          { label: "Two", onclick: () => {} },
          { label: "Three", onclick: () => {} },
        ],
        0,
        0,
      );
      const items = document.querySelectorAll(".context-menu-item");
      (items[0] as HTMLElement).dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      );
      expect(document.activeElement).toBe(items[2]);
    });

    it("Escape closes the menu", () => {
      showContextMenu([{ label: "One", onclick: () => {} }], 0, 0);
      const item = document.querySelector(".context-menu-item") as HTMLElement;
      item.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(document.querySelector(".context-menu")).toBeNull();
    });
  });
});
