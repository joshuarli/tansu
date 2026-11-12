import { describe, expect, it, vi } from "vitest";
import { LocalDraftSession } from "./local-draft-session.ts";
import { localDraftId, serverInstanceId, vaultId, workspaceId } from "./identity.ts";
import { decodeLocalDraftJournalRecord, type LocalDraftJournalRecord } from "./workspace-store.ts";

function fixture(checkpoint = vi.fn((
  _record: LocalDraftJournalRecord,
  _urgency: "typing" | "structural",
  _onFailure: (error: unknown) => void,
) => Promise.resolve(true))) {
  let nextId = 0;
  const session = new LocalDraftSession(
    { serverInstanceId: serverInstanceId("server-a"), vaultId: vaultId("vault-a") },
    workspaceId("workspace-a"),
    localDraftId("local-a"),
    {
      createMutationId: () => `mutation-${++nextId}`,
      checkpoint,
    },
  );
  return { session, checkpoint };
}

describe("LocalDraftSession", () => {
  it("journals title, source, selection, and a stable create mutation identity", async () => {
    const { session, checkpoint } = fixture();

    session.edit("# Draft", { anchor: 7, head: 7 });
    session.editTitle("  First note  ");
    await session.beginPromotion("first-note.md");

    const record = checkpoint.mock.calls.at(-1)?.[0];
    if (record === undefined) throw new Error("Local draft checkpoint was not written");
    expect(record).toMatchObject({
      localDraftId: "local-a",
      localRevision: 2,
      mutationId: "mutation-3",
      source: "# Draft",
      titleDraft: "  First note  ",
      promotionPending: true,
      selection: { anchor: 7, head: 7 },
      createRequest: {
        version: 1,
        mutationId: "mutation-3",
        path: "first-note.md",
        content: "# Draft",
      },
    });
    expect(record.createRequest?.sourceHash).toMatch(/^blake3-v3:[0-9a-f]{64}$/);
    expect(session.state.mutationId).toBe("mutation-3");
    expect(() => session.edit("changed", null)).toThrow("create request is pending");
  });

  it("does not submit an empty title and recovers a pending create for replay", async () => {
    const { session } = fixture();
    session.edit("Draft body", null);
    const originalMutationId = session.state.mutationId;

    await expect(session.beginPromotion("note.md")).resolves.toBeFalsy();
    session.editTitle("Note");
    await session.beginPromotion("note.md");

    const recovered = fixture().session;
    recovered.recover({
      formatVersion: 2,
      kind: "local",
      serverInstanceId: "server-a",
      vaultId: "vault-a",
      workspaceId: "workspace-a",
      localDraftId: localDraftId("local-a"),
      localRevision: session.state.localRevision,
      mutationId: session.state.mutationId,
      source: session.state.source,
      titleDraft: session.state.titleDraft,
      promotionPending: true,
      createRequest: session.state.createRequest,
      selection: null,
      checkpointedAtMs: 1,
    });

    expect(originalMutationId).not.toBe(session.state.mutationId);
    expect(recovered.state.promotionPending).toBeTruthy();
    expect(recovered.state.mutationId).toBe(session.state.mutationId);
    expect(recovered.state.createRequest).toStrictEqual(session.state.createRequest);
    expect(recovered.exportSource()).toBe("Draft body");
    await recovered.beginPromotion("note-2.md");
    expect(recovered.state.createRequest?.path).toBe("note.md");
  });

  it("keeps a legacy pending draft's source without inventing a create request", async () => {
    const recovered = fixture().session;
    const legacy = decodeLocalDraftJournalRecord({
      formatVersion: 2,
      kind: "local",
      serverInstanceId: "server-a",
      vaultId: "vault-a",
      workspaceId: "workspace-a",
      localDraftId: "local-a",
      localRevision: 1,
      mutationId: "mutation-legacy",
      source: "Draft body",
      titleDraft: "Note",
      promotionPending: true,
      selection: null,
      checkpointedAtMs: 1,
    });

    recovered.recover(legacy);

    await expect(recovered.beginPromotion("note-2.md")).resolves.toBeFalsy();
    expect(recovered.state.createRequest).toBeNull();
    expect(recovered.state.promotionPending).toBeTruthy();
    expect(recovered.exportSource()).toBe("Draft body");
  });

  it("keeps the source exportable when checkpoint storage fails", async () => {
    const { session } = fixture(vi.fn(() => Promise.reject(new Error("quota"))));
    session.edit("Recoverable source", null, "structural");

    await expect(session.beginPromotion("note.md")).resolves.toBeFalsy();
    expect(session.state.storage).toBe("failed");
    expect(session.exportSource()).toBe("Recoverable source");
  });
});
