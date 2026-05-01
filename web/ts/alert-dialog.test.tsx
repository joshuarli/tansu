import { render } from "solid-js/web";

import { AlertDialogHost, showAlertDialog } from "./alert-dialog.tsx";
import { setupDOM } from "./test-helper.ts";

describe("alert dialog", () => {
  let cleanup: () => void;
  let dispose: () => void;

  beforeEach(async () => {
    cleanup = setupDOM();
    const { delegateEvents } = await import("solid-js/web");
    delegateEvents(["click", "keydown"]);
    dispose = render(() => AlertDialogHost(), document.querySelector("#app") as HTMLElement);
  });

  afterEach(() => {
    dispose();
    cleanup();
  });

  it("opens with message and closes on OK", async () => {
    const promise = showAlertDialog("Import failed", "Markdown was not produced.");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const overlay = document.querySelector("#alert-dialog-overlay") as HTMLElement;
    expect(overlay.hidden).toBeFalsy();
    expect(overlay.textContent).toContain("Import failed");
    expect(overlay.textContent).toContain("Markdown was not produced.");

    const button = overlay.querySelector("button") as HTMLButtonElement;
    button.click();
    await promise;

    expect(overlay.hidden).toBeTruthy();
  });
});
