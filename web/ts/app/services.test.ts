import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { defaultServices } from "./services.ts";
import { serverInstanceId, vaultId, workspaceId } from "./identity.ts";
import type { WorkspaceState } from "./workspace-store.ts";

describe("default app services", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("persists workspaces under the server and vault identity", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    vi.stubGlobal("localStorage", storage());
    vi.stubGlobal("crypto", { randomUUID: () => "workspace-1" });
    const workspace = defaultServices.workspace.createWorkspaceId();
    const identity = defaultServices.workspace.serverIdentity("server-1", "vault-1");
    const state: WorkspaceState = {
      formatVersion: 1,
      serverInstanceId: identity.serverInstanceId,
      vaultId: identity.vaultId,
      workspaceId: workspace,
      tabs: [],
      activeTab: null,
      closedTabs: [],
      pinnedNoteIds: [],
      recentNoteIds: [],
      searchHistory: [],
      legacySessionImported: false,
      savedAtMs: 1,
    };

    await defaultServices.workspace.saveWorkspaceState(state);

    expect(workspace).toBe(workspaceId("workspace-1"));
    expect(identity).toStrictEqual({
      serverInstanceId: serverInstanceId("server-1"),
      vaultId: vaultId("vault-1"),
    });
    const persisted = await defaultServices.workspace.getWorkspaceState(identity, workspace);
    expect(persisted).toMatchObject({ ...state, savedAtMs: expect.any(Number) });
    expect(persisted?.savedAtMs).toBeGreaterThanOrEqual(state.savedAtMs);
  });

  it("connects the editor and storage adapters to browser capabilities", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = defaultServices.editor.createEditor(host);
    const session = editor.createSession("note-1", "# Note\n");
    editor.attachSession(session);
    expect(editor.getSnapshot()).toMatchObject({ noteId: "note-1", source: "# Note\n" });
    editor.dispose();

    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { ...navigator, storage: { persist } });
    await expect(defaultServices.storage.requestPersistent()).resolves.toBeTruthy();
    expect(persist).toHaveBeenCalledTimes(1);

    vi.stubGlobal("navigator", { ...navigator, storage: undefined });
    await expect(defaultServices.storage.requestPersistent()).resolves.toBeFalsy();
  });
});

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}
