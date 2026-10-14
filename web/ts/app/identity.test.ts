import { describe, expect, it } from "vitest";

import {
  documentIdentityKey,
  localDraftId,
  noteId,
  serverIdentityKey,
  serverInstanceId,
  vaultId,
  workspaceId,
  workspaceIdentityKey,
} from "./identity.ts";

describe("stable client identities", () => {
  it("keeps server, vault, note, workspace, and local draft identities distinct", () => {
    const server = serverInstanceId("server-1");
    const vault = vaultId("vault-1");
    const workspace = workspaceId("workspace-1");
    const identity = { serverInstanceId: server, vaultId: vault };

    expect(serverIdentityKey(identity)).toBe(JSON.stringify(["server-v1", "server-1", "vault-1"]));
    expect(documentIdentityKey({ ...identity, noteId: noteId("note-1") })).toBe(
      JSON.stringify(["document-v1", "server-1", "vault-1", "note-1"]),
    );
    expect(workspaceIdentityKey(identity, workspace)).toBe(
      JSON.stringify(["workspace-v1", "server-1", "vault-1", "workspace-1"]),
    );
    expect(localDraftId("local-1")).toBe("local-1");
  });

  it("rejects empty and untrimmed identity values", () => {
    expect(() => serverInstanceId("")).toThrow("server instance identity must be non-empty and trimmed");
    expect(() => vaultId(" vault-1")).toThrow("vault identity must be non-empty and trimmed");
    expect(() => workspaceId("workspace-1 ")).toThrow("workspace identity must be non-empty and trimmed");
    expect(() => noteId("")).toThrow("note identity must be non-empty and trimmed");
    expect(() => localDraftId(" local-1")).toThrow("local draft identity must be non-empty and trimmed");
  });
});
