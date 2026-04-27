import { createSignal } from "solid-js";

import { renderComponent } from "./component-test-helper.tsx";
import { setupDOM } from "./test-helper.ts";

describe("renderComponent", () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = setupDOM();
  });
  afterEach(() => {
    cleanup();
  });

  it("mounts a component and returns its container", () => {
    const { container, dispose } = renderComponent(() => <p class="msg">hello</p>);
    expect(container.querySelector(".msg")?.textContent).toBe("hello");
    dispose();
  });

  it("removes container from document on dispose", () => {
    const { container, dispose } = renderComponent(() => <span>x</span>);
    expect(document.body.contains(container)).toBe(true);
    dispose();
    expect(document.body.contains(container)).toBe(false);
  });

  it("reflects reactive signal updates", async () => {
    const [text, setText] = createSignal("initial");
    const { container, dispose } = renderComponent(() => <span>{text()}</span>);
    expect(container.querySelector("span")?.textContent).toBe("initial");
    setText("updated");
    await Promise.resolve();
    expect(container.querySelector("span")?.textContent).toBe("updated");
    dispose();
  });
});
