import type { JSX } from "solid-js";
import { render } from "solid-js/web";

type ComponentHarness = {
  container: HTMLElement;
  dispose(): void;
};

/// Render a Solid component into a container appended to document.body.
/// Call dispose() to tear down the reactive tree and remove the container.
export function renderComponent(fn: () => JSX.Element): ComponentHarness {
  const container = document.createElement("div");
  document.body.append(container);
  const disposeRender = render(fn, container);
  return {
    container,
    dispose() {
      disposeRender();
      container.remove();
    },
  };
}
