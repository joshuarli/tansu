import { afterEach, describe, expect, it } from "vitest";

import { installAlembicSkin } from "./alembic.ts";

function surface(): HTMLElement {
  const host = document.createElement("div");
  host.className = "command-panel";
  host.style.setProperty("--skin-frame-size", "20px");
  return host;
}

async function settled(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("alembic skin", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("gives each framed surface one layer that survives its children being replaced", async () => {
    const root = document.createElement("main");
    document.body.append(root);
    installAlembicSkin(root);
    const host = surface();
    root.append(host);
    await settled();
    expect(host.querySelectorAll(".skin-frame-layer")).toHaveLength(1);

    host.replaceChildren(document.createElement("input"));
    await settled();
    expect(host.querySelectorAll(".skin-frame-layer")).toHaveLength(1);
    expect(host.querySelector("input")).not.toBeNull();
  });

  it("keeps one layer when a framed surface is moved", async () => {
    const root = document.createElement("main");
    const slot = document.createElement("section");
    root.append(slot);
    document.body.append(root);
    installAlembicSkin(root);
    const host = surface();
    root.append(host);
    await settled();

    slot.append(host);
    await settled();
    expect(host.querySelectorAll(".skin-frame-layer")).toHaveLength(1);
  });

  it("leaves unrelated elements alone", async () => {
    const root = document.createElement("main");
    document.body.append(root);
    installAlembicSkin(root);
    const other = document.createElement("div");
    other.className = "tabs";
    root.append(other);
    await settled();
    expect(other.childElementCount).toBe(0);
  });
});
