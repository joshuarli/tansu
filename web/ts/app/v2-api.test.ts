import { describe, expect, it, vi } from "vitest";

import {
  V2ApiError,
  V2ProtocolError,
  createV2ApiClient,
  decodeV2NoteMeta,
  decodeV2MutationResponse,
  decodeV2ApiErrorResponse,
  decodeV2ServerEvent,
  decodeV2VaultBootstrap,
  isRetryableV2Error,
  type V2Transport,
} from "./v2-api.ts";
import type { V2ApiErrorKind, V2NoteMeta, V2ServerEvent } from "../types.generated.ts";

const sourceHash = hash("a");
const diskHash = hash("b", "blake3-v2:");

describe("v2 API client", () => {
  it("keeps passkey ceremonies and logout on same-origin v2 auth routes", async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const responses = [
      jsonResponse({ ceremonyId: "login-1", expiresAt: 50, publicKey: { challenge: "AQID" } }),
      jsonResponse({ ok: true, csrfToken: "csrf-1" }),
      jsonResponse({ ceremonyId: "enroll-1", expiresAt: 51, publicKey: { challenge: "BAUG" } }),
      jsonResponse({ ok: true, csrfToken: null }),
      jsonResponse({ ok: true }),
    ];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ path: String(input), init: init ?? {} });
      const response = responses.shift();
      if (response === undefined) throw new Error("No mock auth response remains");
      return response;
    }) as typeof fetch;
    const auth = createV2ApiClient({ fetch: fetcher }).auth;

    const login = await auth.beginLogin();
    await auth.finishLogin(login.ceremonyId, { id: "credential" });
    const enrollment = await auth.beginEnrollment("one-time-capability");
    await auth.finishEnrollment(enrollment.ceremonyId, { id: "registration" });
    await auth.logout();

    expect(calls.map((call) => [call.path, call.init.method])).toStrictEqual([
      ["/api/v2/auth/login/options", "POST"],
      ["/api/v2/auth/login/finish", "POST"],
      ["/api/v2/auth/enrollment/options", "POST"],
      ["/api/v2/auth/enrollment/finish", "POST"],
      ["/api/v2/auth/logout", "POST"],
    ]);
    expect(new Headers(calls[2]?.init.headers).get("X-Tansu-CSRF")).toBeNull();
    expect(JSON.parse(String(calls[2]?.init.body))).toStrictEqual({ capability: "one-time-capability" });
    expect(calls.every((call) => call.init.credentials === "same-origin")).toBeTruthy();
  });

  it("sends the shared CSRF token when enrollment does not use a capability", async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { cookie: "__Host-tansu_csrf=csrf-token" },
    });
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const api = createV2ApiClient({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ path: String(input), init: init ?? {} });
        return jsonResponse(calls.length === 1
          ? { ceremonyId: "enrollment-1", expiresAt: 10, publicKey: {} }
          : { ok: true });
      }) as typeof fetch,
    });

    try {
      await api.auth.beginEnrollment();
      await api.auth.logout();
    } finally {
      if (previous === undefined) delete (globalThis as { document?: unknown }).document;
      else Object.defineProperty(globalThis, "document", previous);
    }

    expect(calls.map(({ path }) => path)).toStrictEqual([
      "/api/v2/auth/enrollment/options",
      "/api/v2/auth/logout",
    ]);
    expect(new Headers(at(calls, 0).init.headers).get("X-Tansu-CSRF")).toBe("csrf-token");
    expect(new Headers(at(calls, 1).init.headers).get("X-Tansu-CSRF")).toBe("csrf-token");
    expect(JSON.parse(String(at(calls, 0).init.body))).toStrictEqual({});
  });

  it("decodes a vault bootstrap without server-side workspace state", () => {
    const bootstrap = decodeV2VaultBootstrap({
      vault: { vaultId: "vault-1", name: "Notes" },
      notes: [],
      settings: settings(),
      searchStatus: { dirty: false, degraded: false },
    });

    expect(bootstrap.vault.vaultId).toBe("vault-1");
  });

  it("uses stable identity headers and routes all note operations through v2", async () => {
    const note = noteMeta("note/id");
    const responses = [
      jsonResponse({ apiVersion: 2, serverInstanceId: "server-1", vaults: [{ vaultId: "vault space", name: "Notes" }] }),
      jsonResponse({ meta: note, content: "# Note\n" }),
      jsonResponse(mutationResponse("create-1")),
      jsonResponse(mutationResponse("save-1")),
      jsonResponse(mutationResponse("rename-1")),
      jsonResponse(mutationResponse("delete-1")),
      jsonResponse([]),
      jsonResponse({ revision: revisionMeta("note/id", 1), content: "# Old\n" }),
      jsonResponse(mutationResponse("restore-1")),
      jsonResponse({ draft: conflictMeta("note/id"), content: "# Draft\n" }),
      jsonResponse(mutationResponse("restore-draft-1")),
      jsonResponse({ mutationId: "settings-1", settings: settings() }),
      jsonResponse({ hits: [], overlayCoverage: { status: "complete" } }),
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
    await vault.renameNote("note/id", { mutationId: "rename-1", precondition: precondition(), path: "Renamed.md" });
    await vault.deleteNote("note/id", { mutationId: "delete-1", precondition: precondition() });
    await vault.listRevisions("note/id");
    await vault.openRevision("note/id", 1);
    await vault.restoreRevision("note/id", 1, { mutationId: "restore-1", precondition: precondition() });
    await vault.openConflictDraft("note/id", 7);
    await vault.restoreConflictDraft("note/id", 7, { mutationId: "restore-draft-1", precondition: precondition() });
    await vault.saveSettings({ mutationId: "settings-1", settings: settings() });
    await vault.search({ query: "needle", mode: "default", limit: 20, overlays: [] });
    await vault.uploadImage("image-1", new Blob(["webp"], { type: "image/webp" }));
    await vault.loadAsset("z-images/a b.webp");

    expect(fetchCalls.map(({ path }) => path)).toStrictEqual([
      "/api/v2/bootstrap",
      "/api/v2/vaults/vault%20space/notes/note%2Fid",
      "/api/v2/vaults/vault%20space/notes",
      "/api/v2/vaults/vault%20space/notes/note%2Fid",
      "/api/v2/vaults/vault%20space/notes/note%2Fid/rename",
      "/api/v2/vaults/vault%20space/notes/note%2Fid",
      "/api/v2/vaults/vault%20space/notes/note%2Fid/revisions",
      "/api/v2/vaults/vault%20space/notes/note%2Fid/revisions/1",
      "/api/v2/vaults/vault%20space/notes/note%2Fid/revisions/1/restore",
      "/api/v2/vaults/vault%20space/notes/note%2Fid/conflicts/7",
      "/api/v2/vaults/vault%20space/notes/note%2Fid/conflicts/7/restore",
      "/api/v2/vaults/vault%20space/settings",
      "/api/v2/vaults/vault%20space/search",
      "/api/v2/vaults/vault%20space/images",
      "/api/v2/vaults/vault%20space/assets?name=z-images%2Fa%20b.webp",
    ]);
    expect(new Headers(at(fetchCalls, 0).init.headers).has("X-Tansu-Server-Instance")).toBeFalsy();
    for (const { init } of fetchCalls.slice(1)) {
      expect(new Headers(init.headers).get("X-Tansu-Server-Instance")).toBe("server-1");
    }
    expect(new Headers(at(fetchCalls, 13).init.headers).get("X-Tansu-Mutation-Id")).toBe("image-1");
    expect(new Headers(at(fetchCalls, 13).init.headers).get("Content-Type")).toBe("image/webp");
    expect(new Headers(at(fetchCalls, 14).init.headers).get("X-Tansu-Server-Instance")).toBe("server-1");
  });

  it("decodes bounded v2 data and rejects incompatible hashes and event flags", () => {
    expect(decodeV2NoteMeta(noteMeta("n")).revision).toBe(1);
    expect(decodeV2ServerEvent({
      eventVersion: 0,
      resyncRequired: false,
      update: { kind: "ready" },
    }).eventVersion).toBe(0);
    expect(() => decodeV2NoteMeta({ ...noteMeta("n"), revision: Number.MAX_SAFE_INTEGER + 1 })).toThrow(V2ProtocolError);
    expect(() => decodeV2NoteMeta({ ...noteMeta("n"), sourceHash: "invalid" })).toThrow(V2ProtocolError);
    expect(() => decodeV2NoteMeta({ ...noteMeta("n"), sourceHashFormatVersion: 2 })).toThrow(V2ProtocolError);
    expect(() => decodeV2ServerEvent({
      eventVersion: 2,
      resyncRequired: true,
      update: { kind: "ready" },
    })).toThrow(V2ProtocolError);
  });

  it("requires only current fields in vault bootstrap responses", () => {
    const bootstrap = {
      vault: { vaultId: "vault-1", name: "Notes" },
      notes: [],
      settings: settings(),
      searchStatus: { dirty: false, degraded: false },
    };

    expect(decodeV2VaultBootstrap(bootstrap).vault.name).toBe("Notes");
  });

  it("keeps error code details and retries only classified transient failures", async () => {
    const fetcher = (async () => jsonResponse({ error: { code: "rate_limited", retryAfterMs: 25 } }, 429)) as typeof fetch;
    const api = createV2ApiClient({ fetch: fetcher });
    const vault = api.forVault("server-1", "vault-1");

    let thrown: unknown;
    try {
      await vault.openNote("note-1");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(V2ApiError);
    expect(thrown).toMatchObject({ status: 429, kind: { code: "rate_limited", retryAfterMs: 25 } });
    expect(isRetryableV2Error(thrown)).toBeTruthy();
    expect(isRetryableV2Error(new V2ProtocolError("bad shape"))).toBeFalsy();
  });

  it("preserves the generated v2 error discriminant and rejects malformed errors", () => {
    const response = decodeV2ApiErrorResponse({ error: { code: "path_collision", path: "A.md" } });
    const error: V2ApiErrorKind = response.error;
    expect(error.code).toBe("path_collision");
    expect(() => decodeV2ApiErrorResponse({})).toThrow(V2ProtocolError);
  });

  it("decodes every server error discriminant with its typed details", () => {
    const current = { meta: noteMeta("note-1"), content: "# Current\n" };
    const draft = {
      draftId: 1,
      noteId: "note-1",
      baseRevision: 1,
      baseSourceHash: sourceHash,
      sourceHash,
      createdAtMs: 10,
    };
    const errors = [
      { code: "api_version_unsupported", requestedVersion: null, supportedVersion: 2 },
      { code: "vault_not_found", vaultId: "vault-1" },
      { code: "server_instance_mismatch", expected: "server-1", received: "server-2" },
      { code: "mutation_id_reuse", mutationId: "mutation-1" },
      { code: "path_invalid", reason: "traversal" },
      { code: "path_collision", path: "note.md" },
      { code: "note_not_found", noteId: "note-1" },
      { code: "revision_not_found", noteId: "note-1", revision: 1 },
      { code: "conflict_draft_not_found", noteId: "note-1", draftId: 1 },
      { code: "asset_not_found", name: "z-images/missing.webp" },
      { code: "save_conflict", current, draft },
      { code: "unresolved_note", noteId: "note-1", reason: "missing_snapshot" },
      { code: "source_hash_mismatch", expected: sourceHash, received: hash("c") },
      { code: "disk_hash_mismatch", expected: diskHash, received: hash("c", "blake3-v2:") },
      { code: "request_too_large", limitBytes: 4096 },
      { code: "auth_required" },
      { code: "forbidden" },
      { code: "csrf_rejected" },
      { code: "origin_rejected" },
      { code: "not_implemented" },
      { code: "rate_limited", retryAfterMs: 50 },
      { code: "bad_request", message: "Invalid request" },
      { code: "internal", requestId: "request-1" },
    ];

    for (const error of errors) {
      expect(decodeV2ApiErrorResponse({ error }).error.code).toBe(error.code);
    }
    expect(() => decodeV2ApiErrorResponse({ error: { code: "unrecognized" } })).toThrow(V2ProtocolError);
  });

  it("decodes accepted, pending, and conflict mutation outcomes", () => {
    expect(decodeV2MutationResponse({
      mutationId: "mutation-1",
      outcome: { state: "accepted", result: noteMeta("note-1") },
    }).outcome.state).toBe("accepted");
    expect(decodeV2MutationResponse({
      mutationId: "mutation-2",
      outcome: { state: "pendingMaterialization", operationId: "operation-1" },
    }).outcome).toMatchObject({ state: "pendingMaterialization", operationId: "operation-1" });
    expect(decodeV2MutationResponse({
      mutationId: "mutation-3",
      outcome: {
        state: "conflict",
        current: { meta: noteMeta("note-1"), content: "# Current\n" },
        draft: {
          draftId: 1,
          noteId: "note-1",
          baseRevision: 1,
          baseSourceHash: sourceHash,
          sourceHash,
          createdAtMs: 10,
        },
      },
    }).outcome.state).toBe("conflict");
  });

  it("decodes each search hit identity and bounded overlay coverage", async () => {
    const hits = [
      {
        identity: { kind: "canonical", noteId: "saved-1", revision: 2, sourceHash },
        title: "Canonical",
        path: "canonical.md",
        score: 1,
        excerpt: "one two",
        excerptRanges: [{ startUtf16: 0, endUtf16: 3 }],
        sourceRange: { startUtf16: 4, endUtf16: 7 },
      },
      {
        identity: { kind: "savedOverlay", noteId: "saved-2", localRevision: 3, sourceHash },
        title: "Saved draft",
        path: "saved.md",
        score: 2,
        excerpt: "body",
        excerptRanges: [],
        sourceRange: null,
      },
      {
        identity: { kind: "newLocalDraft", localId: "local-1", localRevision: 4, sourceHash },
        title: "Local draft",
        path: "",
        score: 3,
        excerpt: "local",
        excerptRanges: [{ startUtf16: 0, endUtf16: 5 }],
        sourceRange: null,
      },
    ];
    const api = createV2ApiClient({
      fetch: (async () => jsonResponse({ hits, overlayCoverage: { status: "partial", skippedNoteCount: 1 } })) as typeof fetch,
    });

    await expect(api.forVault("server-1", "vault-1").search({
      query: "query",
      mode: "default",
      limit: 10,
      overlays: [],
    })).resolves.toMatchObject({ hits, overlayCoverage: { status: "partial", skippedNoteCount: 1 } });

    const invalidRange = createV2ApiClient({
      fetch: (async () => jsonResponse({
        hits: [{ ...at(hits, 0), excerptRanges: [{ startUtf16: 2, endUtf16: 9 }] }],
        overlayCoverage: { status: "complete" },
      })) as typeof fetch,
    });
    await expect(invalidRange.forVault("server-1", "vault-1").search({
      query: "query",
      mode: "default",
      limit: 10,
      overlays: [],
    })).rejects.toBeInstanceOf(V2ProtocolError);
  });

  it("decodes vault, note, deletion, and search server events", () => {
    const events: V2ServerEvent[] = [
      { eventVersion: 1, resyncRequired: false, update: { kind: "vaultChanged", notes: [noteMeta("note-1")] } },
      { eventVersion: 2, resyncRequired: false, update: { kind: "noteChanged", note: noteMeta("note-1") } },
      { eventVersion: 3, resyncRequired: false, update: { kind: "noteDeleted", noteId: "note-1" } },
      { eventVersion: 4, resyncRequired: false, update: { kind: "searchChanged", dirty: true, degraded: false } },
    ];

    expect(events.map((event) => decodeV2ServerEvent(event).update.kind)).toStrictEqual([
      "vaultChanged",
      "noteChanged",
      "noteDeleted",
      "searchChanged",
    ]);
  });

  it("reports malformed and non-JSON HTTP errors as protocol failures", async () => {
    const headers = responseHeaders();
    const malformed = createV2ApiClient({
      fetch: (async () => jsonResponse({}, 409)) as typeof fetch,
    });
    await expect(malformed.forVault("server-1", "vault-1").openNote("note-1")).rejects.toBeInstanceOf(V2ProtocolError);

    const nonJson = createV2ApiClient({
      fetch: (async () => new Response("offline", { status: 500, headers })) as typeof fetch,
    });
    await expect(nonJson.forVault("server-1", "vault-1").openNote("note-1")).rejects.toBeInstanceOf(V2ProtocolError);
  });

  it("rejects response identities and mutation ids that do not match the request", async () => {
    await expect(vaultWithResponse({
      vault: { vaultId: "vault-2", name: "Other" },
      notes: [],
      settings: settings(),
      searchStatus: { dirty: false, degraded: false },
    }).bootstrap()).rejects.toBeInstanceOf(V2ProtocolError);

    await expect(vaultWithResponse({ meta: noteMeta("other-note"), content: "# Other\n" })
      .openNote("note-1")).rejects.toBeInstanceOf(V2ProtocolError);
    await expect(vaultWithResponse([revisionMeta("other-note", 1)]).listRevisions("note-1"))
      .rejects.toBeInstanceOf(V2ProtocolError);
    await expect(vaultWithResponse({ revision: revisionMeta("note-1", 2), content: "# Old\n" })
      .openRevision("note-1", 1)).rejects.toBeInstanceOf(V2ProtocolError);
    await expect(vaultWithResponse({ draft: { ...conflictMeta("note-1"), draftId: 8 }, content: "# Draft\n" })
      .openConflictDraft("note-1", 7)).rejects.toBeInstanceOf(V2ProtocolError);

    await expect(vaultWithResponse(mutationResponse("other-mutation"))
      .createNote({ mutationId: "create-1", path: "new.md", content: "", sourceHash }))
      .rejects.toBeInstanceOf(V2ProtocolError);
    await expect(vaultWithResponse({ mutationId: "save-1", outcome: { state: "accepted", result: noteMeta("other-note") } })
      .saveNote("note-1", { mutationId: "save-1", precondition: precondition(), content: "# Note\n", sourceHash }))
      .rejects.toBeInstanceOf(V2ProtocolError);
    await expect(vaultWithResponse({ mutationId: "settings-1", settings: settings() })
      .saveSettings({ mutationId: "other-mutation", settings: settings() }))
      .rejects.toBeInstanceOf(V2ProtocolError);
    await expect(vaultWithResponse({ mutationId: "other-mutation", name: "z-images/a.webp", markdown: "![[a.webp]]" })
      .uploadImage("image-1", new Blob(["image"], { type: "image/webp" })))
      .rejects.toBeInstanceOf(V2ProtocolError);
  });

  it("decodes note links and previews and rejects malformed or mismatched bodies", async () => {
    const links = {
      backlinks: [{ note: { noteId: "n2", path: "two.md", title: "Two" }, mentions: ["See [[One]]"] }],
      outgoing: [{ noteId: "n3", path: "three.md", title: "Three" }],
    };
    // oxlint-disable-next-line vitest/prefer-strict-equal -- Compare decoded JSON without requiring object prototypes to match.
    await expect(vaultWithResponse(links).noteLinks("n1")).resolves.toEqual(links);
    await expect(vaultWithResponse({ ...links, outgoing: "x" }).noteLinks("n1"))
      .rejects.toBeInstanceOf(V2ProtocolError);
    await expect(vaultWithResponse({ noteId: "n1", preview: "Hello" }).notePreview("n1"))
      .resolves.toStrictEqual({ noteId: "n1", preview: "Hello" });
    await expect(vaultWithResponse({ noteId: "n9", preview: "Hello" }).notePreview("n1"))
      .rejects.toBeInstanceOf(V2ProtocolError);
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

  it("retries transport failures and ignores events at or before the current cursor", async () => {
    const ready: V2ServerEvent = {
      eventVersion: 2,
      resyncRequired: false,
      update: { kind: "ready" },
    };
    const fetchCalls: string[] = [];
    const waits: number[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      if (fetchCalls.length === 1) throw new TypeError("Connection reset");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode([
            `data: ${JSON.stringify({ ...ready, eventVersion: 1 })}\r\n\r\n`,
            `data: ${JSON.stringify(ready)}\r\n\r\n`,
          ].join("")));
          controller.close();
        },
      });
      return new Response(stream, { headers: responseHeaders("text/event-stream") });
    }) as typeof fetch;
    const api = createV2ApiClient({
      fetch: fetcher,
      wait: vi.fn(async (milliseconds) => {
        waits.push(milliseconds);
      }),
    });
    const events: V2ServerEvent[] = [];
    const errors: unknown[] = [];
    const subscription = api.forVault("server-1", "vault-1").connectEvents(1, {
      onEvent: (event) => {
        events.push(event);
        subscription.close();
      },
      onResync: () => {},
      onError: (error) => errors.push(error),
    });
    await until(() => events.length === 1);

    expect(fetchCalls).toHaveLength(2);
    expect(waits).toStrictEqual([1000]);
    expect(errors).toHaveLength(1);
    expect(events).toStrictEqual([ready]);
  });

  it("closes event streams after a non-retryable protocol failure", async () => {
    const fetcher = (async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: not-json\n\n"));
          controller.close();
        },
      }),
      { headers: responseHeaders("text/event-stream") },
    )) as typeof fetch;
    const api = createV2ApiClient({ fetch: fetcher });
    const errors: unknown[] = [];
    const subscription = api.forVault("server-1", "vault-1").connectEvents(0, {
      onEvent: () => {},
      onResync: () => {},
      onError: (error) => errors.push(error),
    });
    await until(() => errors.length === 1);
    subscription.close();

    expect(errors[0]).toBeInstanceOf(V2ProtocolError);
    expect(isRetryableV2Error(errors[0])).toBeFalsy();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: responseHeaders() });
}

function vaultWithResponse(body: unknown) {
  const api = createV2ApiClient({
    fetch: (async () => jsonResponse(body)) as typeof fetch,
  });
  return api.forVault("server-1", "vault-1");
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
    sourceHashFormatVersion: 3,
    diskHashFormatVersion: 2,
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

function hash(
  value: string,
  prefix: "blake3-v2:" | "blake3-v3:" = "blake3-v3:",
): string {
  const hex = value.charCodeAt(0).toString(16).padStart(64, "0");
  return `${prefix}${hex}`;
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
