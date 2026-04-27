import { render } from "solid-js/web";

import { App } from "./app.tsx";
import { setupDOM } from "./test-helper.ts";

describe("app shell", () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = setupDOM();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the legacy shell structure under #app", () => {
    const root = document.querySelector("#app");
    if (!(root instanceof HTMLElement)) {
      throw new Error("missing #app root");
    }

    root.innerHTML = "";
    const dispose = render(App, root);

    expect(root.querySelector("#sidebar")).toBeTruthy();
    expect(root.querySelector("#app-main")).toBeTruthy();
    expect(root.querySelector("#notification")).toBeTruthy();
    expect(root.querySelector("#tab-bar")).toBeTruthy();
    expect(root.querySelector("#server-status")).toBeTruthy();
    expect(root.querySelector("#editor-area")).toBeTruthy();
    expect(root.querySelector("#search-overlay")).toBeTruthy();
    expect(root.querySelector("#settings-overlay")).toBeTruthy();
    expect(root.querySelector("#input-dialog-overlay")).toBeTruthy();
    expect(root.querySelector("#palette-overlay")).toBeTruthy();
    expect(root.querySelector("#empty-state")?.textContent).toContain("Cmd+K");
    expect(root.querySelectorAll(":scope > div")).toHaveLength(6);

    dispose();
  });
});
