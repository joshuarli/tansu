import { describe, expect, it, vi } from "vitest";

import {
  V2ApiError,
  V2ProtocolError,
  createV2ApiClient,
  decodeV2NoteMeta,
  decodeV2ApiErrorResponse,
  decodeV2ServerEvent,
  decodeV2VaultBootstrap,
  isRetryableV2Error,
  type V2Transport,
} from "./v2-api.ts";
import type { V2NoteMeta, V2ServerEvent } from "../types.generated.ts";
import type { V2ApiErrorKind } from "../types.generated.ts";

const sourceHash = hash("a");
const diskHash = hash("b", "sha256:");

describe("v2 API client", () => {
  it("decodes the one-time legacy workspace import seed", () => {
    const bootstrap = decodeV2VaultBootstrap({
      vault: { vaultId: "vault-1", name: "Notes" },
      notes: [],
      settings: settings(),
      searchStatus: { dirty: false, degraded: false },
      legacyWorkspace: {
        session: {
          openTabs: [{ noteId: "note-1", title: "Note", path: "note.md", cursorOffset: 2, sourceMode: false }],
          activeNoteId: "note-1",
          closedTabs: [],
        },
        pinnedNoteIds: ["note-1"],
        recentNoteIds: ["note-1"],
      },
    });

    expect(bootstrap.legacyWorkspace?.session.activeNoteId).toBe("note-1");
    expect(bootstrap.legacyWorkspace?.pinnedNoteIds).toStrictEqual(["note-1"]);
  });

  it("uses stable identity headers and routes all note operations through v2", async () => {
    const note = noteMeta("note/id");
    const responses = [
      jsonResponse({ apiVersion: 2, serverInstanceId: "server-1", vaults: [{ vaultId: "vault space", name: "Notes" }] }),
      jsonResponse({ meta: note, content: "# Note\n" }),
      jsonResponse(mutationResponse("create-1")),
      jsonResponse(mutationResponse("save-1")),
      jsonResponse(mutationResponse("delta-1")),
      jsonResponse(mutationResponse("rename-1")),
      jsonResponse(mutationResponse("delete-1")),
      jsonResponse([]),
      jsonResponse({ revision: revisionMeta("note/id", 1), content: "# Old\n" }),
      jsonResponse(mutationResponse("restore-1")),
      jsonResponse({ draft: conflictMeta("note/id"), content: "# Draft\n" }),
      jsonResponse(mutationResponse("restore-draft-1")),
      jsonResponse(settings()),
      jsonResponse({ mutationId: "settings-1", settings: settings() }),
      jsonResponse({ hits: [], overlayCoverage: { status: "complete" } }),
      jsonResponse({ hits: [] }),
      jsonResponse({ mutationId: "image-1", name: "z-images/a.webp", markdown: "![[a.webp]]" }),
      new Response("image", { headers: responseHeaders("image/webp") }),
    ];
    const fetchCalls: Array<{ path: string; init: RequestInit }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ path: String(input), init: init ?? {} });
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("No mock API response remains");
      }
      return response;
    }) as typeof fetch;
    const api = createV2ApiClient({ fetch: fetcher });
    const bootstrap = await api.bootstrap();
    const firstVault = at(bootstrap.vaults, 0);
    const vault = api.forVault(bootstrap.serverInstanceId, firstVault.vaultId);
    await vault.openNote("note/id");
    await vault.createNote({ mutationId: "create-1", path: "New.md", content: "# New\n", sourceHash });
    await vault.saveNote("note/id", { mutationId: "save-1", precondition: precondition(), content: "# Saved\n", sourceHash });
    await vault.saveNoteDelta("note/id", { mutationId: "delta-1", precondition: precondition(), sourceHash, edits: [] });
    await vault.renameNote("note/id", { mutationId: "rename-1", precondition: precondition(), path: "Renamed.md" });
    await vault.deleteNote("note/id", { mutationId: "delete-1", precondition: precondition() });
    await vault.listRevisions("note/id");
    await vault.openRevision("note/id", 1);
    await vault.restoreRevision("note/id", 1, { mutationId: "restore-1", precondition: precondition() });
    await vault.openConflictDraft("note/id", 7);
    await vault.restoreConflictDraft("note/id", 7, { mutationId: "restore-draft-1", precondition: precondition() });
    await vault.settings();
    await vault.saveSettings({ mutationId: "settings-1", settings: settings() });
    await vault.search({ query: "needle", mode: "default", limit: 20, overlays: [] });
    await vault.quickOpen({ query: "", pinnedNoteIds: ["note/id"], recentNoteIds: [], limit: 20 });
    await vault.uploadImage("image-1", new Blob(["webp"], { type: "image/webp" }));
    await vault.loadAsset("z-images/a b.webp");

    expect(fetchCalls.map(({ path }) => path)).toStrictEqual([
      "/api/v2/bootstrap",
      "/api/v2/vaults/vault%20space/notes/note%2Fid",
      "/api/v2/vaults/vault%20space/notes",
      "/api/v2/vaults/vault%20space/notes/note%2Fid",
      "/api/v2/vaults/vault%20space/notes/note%2Fid",
      "/api/v2/vaults/vault%20space/notes/note%2Fid/rename",
      "/api/v2/vaults/vault%20space/notes/note%2Fid",
      "/api/v2/vaults/vault%20space/notes/note%2Fid/revisions",
      "/api/v2/vaults/vault%20space/notes/note%2Fid/revisions/1",
      "/api/v2/vaults/vault%20space/notes/note%2Fid/revisions/1/restore",
      "/api/v2/vaults/vault%20space/notes/note%2Fid/conflicts/7",
      "/api/v2/vaults/vault%20space/notes/note%2Fid/conflicts/7/restore",
      "/api/v2/vaults/vault%20space/settings",
      "/api/v2/vaults/vault%20space/settings",
      "/api/v2/vaults/vault%20space/search",
      "/api/v2/vaults/vault%20space/quick-open",
      "/api/v2/vaults/vault%20space/images",
      "/api/v2/vaults/vault%20space/assets?name=z-images%2Fa%20b.webp",
    ]);
    expect(new Headers(at(fetchCalls, 0).init.headers).has("X-Tansu-Server-Instance")).toBeFalsy();
    for (const { init } of fetchCalls.slice(1)) {
      expect(new Headers(init.headers).get("X-Tansu-Server-Instance")).toBe("server-1");
    }
    expect(at(fetchCalls, 4).init.method).toBe("PATCH");
    expect(JSON.parse(String(at(fetchCalls, 4).init.body))).toMatchObject({ mutationId: "delta-1", sourceHash });
    expect(new Headers(at(fetchCalls, 16).init.headers).get("X-Tansu-Mutation-Id")).toBe("image-1");
    expect(new Headers(at(fetchCalls, 16).init.headers).get("Content-Type")).toBe("image/webp");
    expect(new Headers(at(fetchCalls, 17).init.headers).get("X-Tansu-Server-Instance")).toBe("server-1");
  });

  it("decodes bounded v2 data and rejects incompatible hashes and event flags", () => {
    expect(decodeV2NoteMeta(noteMeta("n")).revision).toBe(1);
    expect(decodeV2ServerEvent({
      eventVersion: 0,
      resyncRequired: false,
      update: { kind: "ready" },
    }).eventVersion).toBe(0);
    expect(() => decodeV2NoteMeta({ ...noteMeta("n"), revision: Number.MAX_SAFE_INTEGER + 1 })).toThrow(V2ProtocolError);
    expect(() => decodeV2NoteMeta({ ...noteMeta("n"), sourceHash: "sha256:old" })).toThrow(V2ProtocolError);
    expect(() => decodeV2NoteMeta({ ...noteMeta("n"), sourceHashFormatVersion: 1 })).toThrow(V2ProtocolError);
    expect(() => decodeV2ServerEvent({
      eventVersion: 2,
      resyncRequired: true,
      update: { kind: "ready" },
    })).toThrow(V2ProtocolError);
  });

  it("requires the legacy workspace field in vault bootstrap responses", () => {
    const bootstrap = {
      vault: { vaultId: "vault-1", name: "Notes" },
      notes: [],
      settings: settings(),
      searchStatus: { dirty: false, degraded: false },
    };

    expect(() => decodeV2VaultBootstrap(bootstrap)).toThrow(V2ProtocolError);
    expect(decodeV2VaultBootstrap({ ...bootstrap, legacyWorkspace: null }).legacyWorkspace).toBeNull();
  });

  it("keeps error code details and retries only classified transient failures", async () => {
    const fetcher = (async () => jsonResponse({ error: { code: "rate_limited", retryAfterMs: 25 } }, 429)) as typeof fetch;
    const api = createV2ApiClient({ fetch: fetcher });
    const vault = api.forVault("server-1", "vault-1");

    let thrown: unknown;
    try {
      await vault.listNotes();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(V2ApiError);
    expect(thrown).toMatchObject({ status: 429, retryAfterMs: 25 });
    expect(isRetryableV2Error(thrown)).toBeTruthy();
    expect(isRetryableV2Error(new V2ProtocolError("bad shape"))).toBeFalsy();
  });

  it("preserves the generated v2 error discriminant and rejects malformed errors", () => {
    const response = decodeV2ApiErrorResponse({ error: { code: "path_collision", path: "A.md" } });
    const error: V2ApiErrorKind = response.error;
    expect(error.code).toBe("path_collision");
    expect(() => decodeV2ApiErrorResponse({})).toThrow(V2ProtocolError);
  });

  it("reports malformed and non-JSON HTTP errors as protocol failures", async () => {
    const headers = responseHeaders();
    const malformed = createV2ApiClient({
      fetch: (async () => jsonResponse({}, 409)) as typeof fetch,
    });
    await expect(malformed.forVault("server-1", "vault-1").listNotes()).rejects.toBeInstanceOf(V2ProtocolError);

    const nonJson = createV2ApiClient({
      fetch: (async () => new Response("offline", { status: 500, headers })) as typeof fetch,
    });
    await expect(nonJson.forVault("server-1", "vault-1").listNotes()).rejects.toBeInstanceOf(V2ProtocolError);
  });

  it("reads the shared CSRF cookie for mutations and sends it with image uploads", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { cookie: "theme=dark; __Host-tansu_csrf=csrf%2Dtoken" },
    });
    try {
      const fetchCalls: Array<{ path: string; init: RequestInit }> = [];
      const responses = [jsonResponse(mutationResponse("create-1")), jsonResponse({ mutationId: "image-1", name: "z-images/a.webp", markdown: "![[a]]" })];
      const api = createV2ApiClient({
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          fetchCalls.push({ path: String(input), init: init ?? {} });
          const response = responses.shift();
          if (response === undefined) throw new Error("No mock API response remains");
          return response;
        }) as typeof fetch,
      });
      const vault = api.forVault("server-1", "vault-1");
      await vault.createNote({ mutationId: "create-1", path: "A.md", content: "A", sourceHash });
      await vault.uploadImage("image-1", new Blob(["x"], { type: "image/webp" }));

      expect(new Headers(at(fetchCalls, 0).init.headers).get("X-Tansu-CSRF")).toBe("csrf-token");
      expect(new Headers(at(fetchCalls, 1).init.headers).get("X-Tansu-CSRF")).toBe("csrf-token");
      expect(at(fetchCalls, 0).init.credentials).toBe("same-origin");
      expect(at(fetchCalls, 1).init.credentials).toBe("same-origin");
    } finally {
      if (previous === undefined) delete (globalThis as { document?: unknown }).document;
      else Object.defineProperty(globalThis, "document", previous);
    }
  });

  it("resynchronizes on the server flag and reconnects from its event version", async () => {
    const resync: V2ServerEvent = {
      eventVersion: 3,
      resyncRequired: true,
      update: { kind: "resyncRequired" },
    };
    const ready: V2ServerEvent = {
      eventVersion: 4,
      resyncRequired: false,
      update: { kind: "ready" },
    };
    const eventStream = (event: V2ServerEvent) => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    });
    const fetchCalls: Array<{ path: string; init: RequestInit }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      fetchCalls.push({ path, init: init ?? {} });
      if (path.endsWith("/events?after=1")) {
        return new Response(eventStream(resync), { headers: responseHeaders("text/event-stream") });
      }
      if (path.endsWith("/events?after=3")) {
        return new Response(eventStream(ready), { headers: responseHeaders("text/event-stream") });
      }
      if (path.endsWith("/bootstrap")) {
        return jsonResponse({
          vault: { vaultId: "vault-1", name: "Notes" },
          notes: [],
          settings: settings(),
          searchStatus: { dirty: false, degraded: false },
          legacyWorkspace: null,
        });
      }
      if (path.endsWith("/notes")) {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected request ${path}`);
    }) as typeof fetch;
    const api = createV2ApiClient({ fetch: fetcher, wait: vi.fn(async () => {}) as V2Transport["wait"] });
    const events: V2ServerEvent[] = [];
    const snapshots: number[] = [];
    const subscription = api.forVault("server-1", "vault-1").connectEvents(1, {
      onEvent: (next) => {
        events.push(next);
        if (next.eventVersion === 4) {
          subscription.close();
        }
      },
      onResync: (snapshot) => {
        snapshots.push(snapshot.eventVersion);
      },
    });
    await until(() => events.length === 1);

    expect(snapshots).toStrictEqual([3]);
    expect(events).toStrictEqual([ready]);
    expect(at(fetchCalls, 0).path).toBe("/api/v2/vaults/vault-1/events?after=1");
    expect(at(fetchCalls, 1).path).toBe("/api/v2/vaults/vault-1/bootstrap");
    expect(at(fetchCalls, 2).path).toBe("/api/v2/vaults/vault-1/notes");
    expect(at(fetchCalls, 3).path).toBe("/api/v2/vaults/vault-1/events?after=3");
    expect(new Headers(at(fetchCalls, 0).init.headers).get("X-Tansu-Server-Instance")).toBe("server-1");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: responseHeaders() });
}

function responseHeaders(contentType = "application/json"): HeadersInit {
  return {
    "Content-Type": contentType,
    "X-Tansu-Api-Version": "2",
    "X-Tansu-Build-Id": "test-build",
  };
}

function noteMeta(noteId: string): V2NoteMeta {
  return {
    noteId,
    path: "note.md",
    title: "Note",
    tags: [],
    revision: 1,
    sourceHash,
    diskHash,
    sourceHashFormatVersion: 2,
    diskHashFormatVersion: 1,
    updatedAtMs: 10,
  };
}

function mutationResponse(mutationId: string) {
  return { mutationId, outcome: { state: "accepted", result: null } };
}

function precondition() {
  return { baseRevision: 1, baseSourceHash: sourceHash, baseDiskHash: diskHash };
}

function revisionMeta(noteId: string, revision: number) {
  return { noteId, revision, kind: "save", source: "user", sourceHash, createdAtMs: revision };
}

function conflictMeta(noteId: string) {
  return {
    draftId: 7,
    noteId,
    baseRevision: 1,
    baseSourceHash: sourceHash,
    sourceHash,
    createdAtMs: 10,
  };
}

function settings() {
  return {
    excludedFolders: [],
    searchTitleWeight: 3,
    searchHeadingWeight: 2,
    searchTagWeight: 2,
    searchContentWeight: 1,
    recencyBoost: 0,
    autosaveDelayMs: 900,
    undoStackMax: 100,
    imageWebpQuality: 0.8,
  };
}

function hash(value: string, prefix: "sha256:" | "sha256-v2:" = "sha256-v2:"): string {
  const hex = value.charCodeAt(0).toString(16).padStart(64, "0");
  return `${prefix}${hex}`;
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Expected asynchronous work did not finish");
}

function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`Missing item at index ${index}`);
  }
  return item;
}
