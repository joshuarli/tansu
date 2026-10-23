import type {
  Settings,
  V2ApiErrorKind,
  V2ApiErrorResponse,
  V2BootstrapResponse,
  V2ConflictDraftDocument,
  V2CreateNoteRequest,
  V2DeleteNoteRequest,
  V2ImageUploadResponse,
  V2LinkedNote,
  V2MutationResponse,
  V2NoteDocument,
  V2NoteLinksResponse,
  V2NoteMeta,
  V2NotePreview,
  V2RevisionDocument,
  V2RevisionMeta,
  V2SaveNoteRequest,
  V2RenameNoteRequest,
  V2RestoreConflictRequest,
  V2RestoreRevisionRequest,
  V2SearchRequest,
  V2SearchResponse,
  V2ServerEvent,
  V2SettingsRequest,
  V2SettingsResponse,
  V2VaultBootstrapResponse,
  V2VaultMeta,
} from "../types.generated.ts";
import {
  noteId as toNoteId,
  serverInstanceId as toServerInstanceId,
  vaultId as toVaultId,
  type ServerIdentity,
} from "./identity.ts";

export class V2ApiError extends Error {
  readonly status: number;
  readonly kind: V2ApiErrorKind | null;

  constructor(message: string, status: number, kind: V2ApiErrorKind | null) {
    super(message);
    this.name = "V2ApiError";
    this.status = status;
    this.kind = kind;
  }
}

export class V2ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V2ProtocolError";
  }
}

export type V2VaultBootstrap = V2VaultBootstrapResponse;

export type V2VaultSnapshot = {
  bootstrap: V2VaultBootstrap;
  notes: V2NoteMeta[];
  eventVersion: number;
};

export type V2EventHandlers = {
  onEvent: (event: V2ServerEvent) => void;
  onResync: (snapshot: V2VaultSnapshot) => void | Promise<void>;
  onError?: (error: unknown) => void;
};

export type V2EventSubscription = {
  close: () => void;
};

export type V2VaultClient = {
  bootstrap: (signal?: AbortSignal) => Promise<V2VaultBootstrap>;
  openNote: (id: string, signal?: AbortSignal) => Promise<V2NoteDocument>;
  createNote: (request: V2CreateNoteRequest, signal?: AbortSignal) => Promise<V2MutationResponse>;
  saveNote: (id: string, request: V2SaveNoteRequest, signal?: AbortSignal) => Promise<V2MutationResponse>;
  renameNote: (
    id: string,
    request: V2RenameNoteRequest,
    signal?: AbortSignal,
  ) => Promise<V2MutationResponse>;
  deleteNote: (
    id: string,
    request: V2DeleteNoteRequest,
    signal?: AbortSignal,
  ) => Promise<V2MutationResponse>;
  noteLinks: (id: string, signal?: AbortSignal) => Promise<V2NoteLinksResponse>;
  notePreview: (id: string, signal?: AbortSignal) => Promise<V2NotePreview>;
  listRevisions: (id: string, signal?: AbortSignal) => Promise<V2RevisionMeta[]>;
  openRevision: (id: string, revision: number, signal?: AbortSignal) => Promise<V2RevisionDocument>;
  openConflictDraft: (id: string, draftId: number, signal?: AbortSignal) => Promise<V2ConflictDraftDocument>;
  restoreRevision: (
    id: string,
    revision: number,
    request: V2RestoreRevisionRequest,
    signal?: AbortSignal,
  ) => Promise<V2MutationResponse>;
  restoreConflictDraft: (
    id: string,
    draftId: number,
    request: V2RestoreConflictRequest,
    signal?: AbortSignal,
  ) => Promise<V2MutationResponse>;
  saveSettings: (request: V2SettingsRequest, signal?: AbortSignal) => Promise<V2SettingsResponse>;
  search: (request: V2SearchRequest, signal?: AbortSignal) => Promise<V2SearchResponse>;
  uploadImage: (mutationId: string, image: Blob, signal?: AbortSignal) => Promise<V2ImageUploadResponse>;
  loadAsset: (name: string, signal?: AbortSignal) => Promise<Blob>;
  connectEvents: (afterEventVersion: number, handlers: V2EventHandlers) => V2EventSubscription;
};

export type V2ApiClient = {
  auth: V2AuthClient;
  bootstrap: (signal?: AbortSignal) => Promise<V2BootstrapResponse>;
  forVault: (serverInstanceId: string, vaultId: string) => V2VaultClient;
};

export type V2AuthCeremony = {
  ceremonyId: string;
  expiresAt: number;
  publicKey: Record<string, unknown>;
};

export type V2AuthClient = {
  beginLogin: (signal?: AbortSignal) => Promise<V2AuthCeremony>;
  finishLogin: (ceremonyId: string, credential: unknown, signal?: AbortSignal) => Promise<void>;
  beginEnrollment: (capability?: string, signal?: AbortSignal) => Promise<V2AuthCeremony>;
  finishEnrollment: (ceremonyId: string, credential: unknown, signal?: AbortSignal) => Promise<void>;
  logout: (signal?: AbortSignal) => Promise<void>;
};

export type V2Transport = {
  fetch: typeof fetch;
  wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

function decodeAuthCeremony(value: unknown): V2AuthCeremony {
  const body = record(value, "authentication ceremony");
  return {
    ceremonyId: nonEmptyString(field(body, "ceremonyId"), "ceremonyId"),
    expiresAt: integer(field(body, "expiresAt"), "expiresAt"),
    publicKey: record(field(body, "publicKey"), "publicKey options"),
  };
}

function decodeAuthFinish(value: unknown): { ok: true } {
  const body = record(value, "authentication response");
  if (field(body, "ok") !== true) throw new V2ProtocolError("Authentication response was not successful");
  return { ok: true };
}

export function createV2ApiClient(transport: Partial<V2Transport> = {}): V2ApiClient {
  const request = transport.fetch ?? globalThis.fetch.bind(globalThis);
  const wait = transport.wait ?? waitForReconnect;

  return {
    auth: {
      beginLogin: (signal) => getJson(
        request,
        "/api/v2/auth/login/options",
        decodeAuthCeremony,
        undefined,
        signal,
        "POST",
        "{}",
      ),
      finishLogin: async (ceremonyId, credential, signal) => {
        await getJson(
          request,
          "/api/v2/auth/login/finish",
          decodeAuthFinish,
          undefined,
          signal,
          "POST",
          JSON.stringify({ ceremonyId, credential }),
        );
      },
      beginEnrollment: (capability, signal) => {
        const body = capability === undefined ? {} : { capability };
        const headers = new Headers();
        if (capability === undefined) {
          const csrf = readCsrfCookie();
          if (csrf !== null) headers.set("X-Tansu-CSRF", csrf);
        }
        return getJson(
          request,
          "/api/v2/auth/enrollment/options",
          decodeAuthCeremony,
          headers,
          signal,
          "POST",
          JSON.stringify(body),
        );
      },
      finishEnrollment: async (ceremonyId, credential, signal) => {
        await getJson(
          request,
          "/api/v2/auth/enrollment/finish",
          decodeAuthFinish,
          undefined,
          signal,
          "POST",
          JSON.stringify({ ceremonyId, credential }),
        );
      },
      logout: async (signal) => {
        const headers = new Headers();
        const csrf = readCsrfCookie();
        if (csrf !== null) headers.set("X-Tansu-CSRF", csrf);
        await getJson(
          request,
          "/api/v2/auth/logout",
          decodeAuthFinish,
          headers,
          signal,
          "POST",
          "{}",
        );
      },
    },
    bootstrap: (signal) => getJson(request, "/api/v2/bootstrap", decodeV2Bootstrap, undefined, signal),
    forVault(serverId, vault) {
      const identity: ServerIdentity = {
        serverInstanceId: toServerInstanceId(serverId),
        vaultId: toVaultId(vault),
      };
      const vaultPath = `/api/v2/vaults/${encodeURIComponent(identity.vaultId)}`;
      const headers = () => new Headers({ "X-Tansu-Server-Instance": identity.serverInstanceId });
      const get = <T>(path: string, decode: Decoder<T>, signal?: AbortSignal) =>
        getJson(request, `${vaultPath}${path}`, decode, headers(), signal);
      const send = <T>(
        path: string,
        method: string,
        body: unknown,
        decode: Decoder<T>,
        signal?: AbortSignal,
        extraHeaders?: HeadersInit,
        csrfProtected = true,
      ) => {
        const outgoing = new Headers(headers());
        new Headers(extraHeaders).forEach((value, key) => outgoing.set(key, value));
        outgoing.set("Content-Type", "application/json");
        if (csrfProtected) {
          const csrf = readCsrfCookie();
          if (csrf !== null) outgoing.set("X-Tansu-CSRF", csrf);
        }
        return getJson(
          request,
          `${vaultPath}${path}`,
          decode,
          outgoing,
          signal,
          method,
          JSON.stringify(body),
        );
      };
      const notePath = (id: string) => `/notes/${encodeURIComponent(toNoteId(id))}`;

      return {
        bootstrap: async (signal) => {
          const value = await get("/bootstrap", decodeV2VaultBootstrap, signal);
          if (value.vault.vaultId !== identity.vaultId) {
            throw new V2ProtocolError("Vault bootstrap identity does not match the request");
          }
          return value;
        },
        openNote: async (id, signal) => {
          const note = await get(notePath(id), decodeV2NoteDocument, signal);
          assertNoteId(note.meta, id);
          return note;
        },
        createNote: async (body, signal) => {
          const result = await send("/notes", "POST", body, decodeV2MutationResponse, signal);
          assertMutationId(result, body.mutationId);
          return result;
        },
        saveNote: async (id, body, signal) => {
          const result = await send(notePath(id), "PUT", body, decodeV2MutationResponse, signal);
          assertMutationId(result, body.mutationId);
          assertMutationIdentity(result, id);
          return result;
        },
        renameNote: async (id, body, signal) => {
          const result = await send(`${notePath(id)}/rename`, "POST", body, decodeV2MutationResponse, signal);
          assertMutationId(result, body.mutationId);
          assertMutationIdentity(result, id);
          return result;
        },
        deleteNote: async (id, body, signal) => {
          const result = await send(notePath(id), "DELETE", body, decodeV2MutationResponse, signal);
          assertMutationId(result, body.mutationId);
          assertMutationIdentity(result, id);
          return result;
        },
        noteLinks: (id, signal) => get(`${notePath(id)}/links`, decodeV2NoteLinksResponse, signal),
        notePreview: async (id, signal) => {
          const value = await get(`${notePath(id)}/preview`, decodeV2NotePreview, signal);
          if (value.noteId !== id) throw new V2ProtocolError("Preview identity does not match the request");
          return value;
        },
        listRevisions: async (id, signal) => {
          const values = await get(`${notePath(id)}/revisions`, decodeV2RevisionMetaArray, signal);
          if (values.some((revision) => revision.noteId !== id)) {
            throw new V2ProtocolError("Revision list contains a different note identity");
          }
          return values;
        },
        openRevision: async (id, revision, signal) => {
          const value = await get(`${notePath(id)}/revisions/${positiveSafeInteger(revision, "revision")}`, decodeV2RevisionDocument, signal);
          if (value.revision.noteId !== id || value.revision.revision !== revision) {
            throw new V2ProtocolError("Revision response identity does not match the request");
          }
          return value;
        },
        openConflictDraft: async (id, draftId, signal) => {
          const value = await get(`${notePath(id)}/conflicts/${positiveSafeInteger(draftId, "draft id")}`, decodeV2ConflictDraftDocument, signal);
          if (value.draft.noteId !== id || value.draft.draftId !== draftId) {
            throw new V2ProtocolError("Conflict draft identity does not match the request");
          }
          return value;
        },
        restoreRevision: async (id, revision, body, signal) => {
          const result = await send(`${notePath(id)}/revisions/${positiveSafeInteger(revision, "revision")}/restore`, "POST", body, decodeV2MutationResponse, signal);
          assertMutationId(result, body.mutationId);
          assertMutationIdentity(result, id);
          return result;
        },
        restoreConflictDraft: async (id, draftId, body, signal) => {
          const result = await send(`${notePath(id)}/conflicts/${positiveSafeInteger(draftId, "draft id")}/restore`, "POST", body, decodeV2MutationResponse, signal);
          assertMutationId(result, body.mutationId);
          assertMutationIdentity(result, id);
          return result;
        },
        saveSettings: async (body, signal) => {
          const result = await send("/settings", "PUT", body, decodeV2SettingsResponse, signal);
          if (result.mutationId !== body.mutationId) {
            throw new V2ProtocolError("Settings response mutation identity does not match the request");
          }
          return result;
        },
        search: (body, signal) => send("/search", "POST", body, decodeV2SearchResponse, signal, undefined, false),
        uploadImage: async (mutationId, image, signal) => {
          assertMutationIdValue(mutationId);
          const csrf = readCsrfCookie();
          const uploadHeaders = new Headers({
            ...Object.fromEntries(headers()),
            "Content-Type": "image/webp",
            "X-Tansu-Mutation-Id": mutationId,
          });
          if (csrf !== null) uploadHeaders.set("X-Tansu-CSRF", csrf);
          const response = await request(`${vaultPath}/images`, {
            method: "POST",
            headers: uploadHeaders,
            body: image,
            credentials: "same-origin",
            ...(signal === undefined ? {} : { signal }),
          });
          return decodeResponse(response, decodeV2ImageUploadResponse).then((value) => {
            if (value.mutationId !== mutationId) {
              throw new V2ProtocolError("Image response mutation identity does not match the request");
            }
            return value;
          });
        },
        loadAsset: async (name, signal) => {
          const options: RequestInit = { headers: headers() };
          if (signal !== undefined) {
            options.signal = signal;
          }
          const response = await request(
            `${vaultPath}/assets?name=${encodeURIComponent(nonEmptyString(name, "asset name"))}`,
            options,
          );
          checkResponseHeaders(response.headers);
          if (!response.ok) {
            await throwHttpError(response);
          }
          return response.blob();
        },
        connectEvents: (after, handlers) =>
          connectEvents(request, wait, vaultPath, headers(), identity.vaultId, after, handlers),
      } satisfies V2VaultClient;
    },
  };
}

export function decodeV2Bootstrap(value: unknown): V2BootstrapResponse {
  const body = record(value, "bootstrap");
  if (integer(field(body, "apiVersion"), "apiVersion", 2, 2) !== 2) {
    throw new V2ProtocolError("Unsupported API version in bootstrap");
  }
  return {
    apiVersion: 2,
    serverInstanceId: nonEmptyString(field(body, "serverInstanceId"), "serverInstanceId"),
    vaults: array(field(body, "vaults"), "vaults").map(decodeV2VaultMeta),
  };
}

export function decodeV2VaultBootstrap(value: unknown): V2VaultBootstrap {
  const body = record(value, "vault bootstrap");
  return {
    vault: decodeV2VaultMeta(field(body, "vault")),
    notes: decodeV2NoteMetaArray(field(body, "notes")),
    settings: decodeSettings(field(body, "settings")),
    searchStatus: decodeSearchStatus(field(body, "searchStatus")),
  };
}

export function decodeV2NoteMeta(value: unknown): V2NoteMeta {
  const body = record(value, "note metadata");
  const sourceHash = hash(field(body, "sourceHash"), "sourceHash", "source");
  const diskHash = hash(field(body, "diskHash"), "diskHash", "disk");
  const sourceHashFormatVersion = hashVersion(
    sourceHash,
    integer(field(body, "sourceHashFormatVersion"), "sourceHashFormatVersion", 1, 3),
    "source",
  );
  const diskHashFormatVersion = hashVersion(
    diskHash,
    integer(field(body, "diskHashFormatVersion"), "diskHashFormatVersion", 1, 2),
    "disk",
  );
  return {
    noteId: nonEmptyString(field(body, "noteId"), "noteId"),
    path: string(field(body, "path"), "path"),
    title: string(field(body, "title"), "title"),
    tags: array(field(body, "tags"), "tags").map((tag) => string(tag, "tag")),
    revision: integer(field(body, "revision"), "revision"),
    sourceHash,
    diskHash,
    sourceHashFormatVersion,
    diskHashFormatVersion,
    updatedAtMs: integer(field(body, "updatedAtMs"), "updatedAtMs"),
  };
}

export function decodeV2NoteDocument(value: unknown): V2NoteDocument {
  const body = record(value, "note document");
  return { meta: decodeV2NoteMeta(field(body, "meta")), content: string(field(body, "content"), "content") };
}

export function decodeV2MutationResponse(value: unknown): V2MutationResponse {
  const body = record(value, "mutation response");
  const outcome = record(field(body, "outcome"), "mutation outcome");
  const state = string(field(outcome, "state"), "mutation outcome state");
  const decoded = state === "accepted"
    ? { state, result: field(outcome, "result") === null ? null : decodeV2NoteMeta(field(outcome, "result")) }
    : state === "pendingMaterialization"
    ? { state, operationId: nonEmptyString(field(outcome, "operationId"), "operationId") }
    : state === "conflict"
    ? {
      state,
      current: decodeV2NoteDocument(field(outcome, "current")),
      draft: decodeV2ConflictDraftMeta(field(outcome, "draft")),
    }
    : fail<V2MutationResponse>("Unknown mutation outcome state");
  return { mutationId: mutationId(field(body, "mutationId")), outcome: decoded } as V2MutationResponse;
}

export function decodeV2ApiErrorResponse(value: unknown): V2ApiErrorResponse {
  const body = record(value, "API error response");
  const error = record(field(body, "error"), "API error");
  const code = string(field(error, "code"), "API error code");
  const decoded: Record<string, unknown> = { code };
  switch (code) {
    case "api_version_unsupported": {
      decoded["requestedVersion"] = field(error, "requestedVersion") === null
        ? null
        : integer(field(error, "requestedVersion"), "requestedVersion");
      decoded["supportedVersion"] = integer(field(error, "supportedVersion"), "supportedVersion");
      break;
    }
    case "vault_not_found": {
      decoded["vaultId"] = nonEmptyString(field(error, "vaultId"), "vaultId");
      break;
    }
    case "server_instance_mismatch": {
      decoded["expected"] = nonEmptyString(field(error, "expected"), "expected");
      decoded["received"] = string(field(error, "received"), "received");
      break;
    }
    case "mutation_id_reuse": {
      decoded["mutationId"] = mutationId(field(error, "mutationId"));
      break;
    }
    case "path_invalid": {
      decoded["reason"] = oneOf(field(error, "reason"), "reason", ["empty", "absolute", "traversal", "dot_tansu", "not_markdown", "nested_vault"]);
      break;
    }
    case "path_collision": {
      decoded["path"] = string(field(error, "path"), "path");
      break;
    }
    case "note_not_found": {
      decoded["noteId"] = nonEmptyString(field(error, "noteId"), "noteId");
      break;
    }
    case "revision_not_found": {
      decoded["noteId"] = nonEmptyString(field(error, "noteId"), "noteId");
      decoded["revision"] = positiveSafeInteger(field(error, "revision"), "revision");
      break;
    }
    case "conflict_draft_not_found": {
      decoded["noteId"] = nonEmptyString(field(error, "noteId"), "noteId");
      decoded["draftId"] = positiveSafeInteger(field(error, "draftId"), "draftId");
      break;
    }
    case "asset_not_found": {
      decoded["name"] = nonEmptyString(field(error, "name"), "name");
      break;
    }
    case "save_conflict": {
      decoded["current"] = decodeV2NoteDocument(field(error, "current"));
      decoded["draft"] = decodeV2ConflictDraftMeta(field(error, "draft"));
      break;
    }
    case "unresolved_note": {
      decoded["noteId"] = nonEmptyString(field(error, "noteId"), "noteId");
      decoded["reason"] = oneOf(field(error, "reason"), "reason", ["case_fold_collision", "invalid_utf8", "missing_snapshot", "corrupt_snapshot", "file_catalog_mismatch"]);
      break;
    }
    case "source_hash_mismatch": {
      decoded["expected"] = hash(field(error, "expected"), "expected", "source");
      decoded["received"] = hash(field(error, "received"), "received", "source");
      break;
    }
    case "disk_hash_mismatch": {
      decoded["expected"] = hash(field(error, "expected"), "expected", "disk");
      decoded["received"] = hash(field(error, "received"), "received", "disk");
      break;
    }
    case "request_too_large": {
      decoded["limitBytes"] = integer(field(error, "limitBytes"), "limitBytes");
      break;
    }
    case "auth_required":
    case "forbidden":
    case "csrf_rejected":
    case "origin_rejected":
    case "not_implemented": {
      break;
    }
    case "rate_limited": {
      decoded["retryAfterMs"] = integer(field(error, "retryAfterMs"), "retryAfterMs");
      break;
    }
    case "bad_request": {
      decoded["message"] = string(field(error, "message"), "message");
      break;
    }
    case "internal": {
      decoded["requestId"] = nonEmptyString(field(error, "requestId"), "requestId");
      break;
    }
    default: {
      return fail("Unknown API error code");
    }
  }
  return { error: decoded as V2ApiErrorKind };
}

export function decodeV2ServerEvent(value: unknown): V2ServerEvent {
  const body = record(value, "server event");
  const update = record(field(body, "update"), "server event update");
  const kind = string(field(update, "kind"), "server event update kind");
  let decoded: V2ServerEvent["update"];
  switch (kind) {
    case "ready": {
      decoded = { kind };
      break;
    }
    case "vaultChanged": {
      decoded = { kind, notes: decodeV2NoteMetaArray(field(update, "notes")) };
      break;
    }
    case "noteChanged": {
      decoded = { kind, note: decodeV2NoteMeta(field(update, "note")) };
      break;
    }
    case "noteDeleted": {
      decoded = { kind, noteId: nonEmptyString(field(update, "noteId"), "noteId") };
      break;
    }
    case "searchChanged": {
      decoded = { kind, dirty: boolean(field(update, "dirty"), "dirty"), degraded: boolean(field(update, "degraded"), "degraded") };
      break;
    }
    case "resyncRequired": {
      decoded = { kind };
      break;
    }
    default: {
      return fail("Unknown server event update");
    }
  }
  const resyncRequired = boolean(field(body, "resyncRequired"), "resyncRequired");
  if (resyncRequired !== (kind === "resyncRequired")) {
    throw new V2ProtocolError("SSE resync flag does not match its update");
  }
  return {
    eventVersion: integer(field(body, "eventVersion"), "eventVersion"),
    resyncRequired,
    update: decoded,
  };
}

type Decoder<T> = (value: unknown) => T;

async function getJson<T>(
  fetcher: typeof fetch,
  path: string,
  decode: Decoder<T>,
  headers?: HeadersInit,
  signal?: AbortSignal,
  method = "GET",
  body?: string,
): Promise<T> {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Accept", "application/json");
  if (body !== undefined) {
    requestHeaders.set("Content-Type", "application/json");
  }
  const options: RequestInit = { method, headers: requestHeaders };
  options.credentials = "same-origin";
  if (body !== undefined) {
    options.body = body;
  }
  if (signal !== undefined) {
    options.signal = signal;
  }
  const response = await fetcher(path, options);
  return decodeResponse(response, decode);
}

function readCsrfCookie(): string | null {
  if (typeof document === "undefined") return null;
  const cookie = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("__Host-tansu_csrf="));
  if (cookie === undefined) return null;
  const raw = cookie.slice("__Host-tansu_csrf=".length);
  if (raw === "") return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new V2ProtocolError("CSRF cookie is not valid URL encoding");
  }
}

async function decodeResponse<T>(response: Response, decode: Decoder<T>): Promise<T> {
  checkResponseHeaders(response.headers);
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new V2ProtocolError(`Response body is not valid JSON: ${String(error)}`);
  }
  if (!response.ok) {
    let kind: V2ApiErrorKind | null = null;
    try {
      kind = decodeV2ApiErrorResponse(body).error;
    } catch {
      throw new V2ProtocolError(`HTTP ${response.status} returned an invalid v2 error`);
    }
    throw new V2ApiError(`V2 API request failed with HTTP ${response.status}`, response.status, kind);
  }
  return decode(body);
}

function checkResponseHeaders(headers: Headers): void {
  const version = headers.get("X-Tansu-Api-Version");
  const buildId = headers.get("X-Tansu-Build-Id");
  if (version !== "2" || buildId === null || buildId.length === 0) {
    throw new V2ProtocolError("Response is missing the v2 API version or build identity");
  }
}

function decodeV2VaultMeta(value: unknown): V2VaultMeta {
  const body = record(value, "vault metadata");
  return {
    vaultId: nonEmptyString(field(body, "vaultId"), "vaultId"),
    name: string(field(body, "name"), "name"),
  };
}

function decodeV2NoteMetaArray(value: unknown): V2NoteMeta[] {
  return array(value, "notes").map(decodeV2NoteMeta);
}

function decodeV2ConflictDraftMeta(value: unknown) {
  const body = record(value, "conflict draft metadata");
  return {
    draftId: positiveSafeInteger(field(body, "draftId"), "draftId"),
    noteId: nonEmptyString(field(body, "noteId"), "noteId"),
    baseRevision: integer(field(body, "baseRevision"), "baseRevision"),
    baseSourceHash: hash(field(body, "baseSourceHash"), "baseSourceHash", "source"),
    sourceHash: hash(field(body, "sourceHash"), "sourceHash", "source"),
    createdAtMs: integer(field(body, "createdAtMs"), "createdAtMs"),
  };
}

function decodeV2ConflictDraftDocument(value: unknown): V2ConflictDraftDocument {
  const body = record(value, "conflict draft");
  return {
    draft: decodeV2ConflictDraftMeta(field(body, "draft")),
    content: string(field(body, "content"), "content"),
  };
}

function decodeV2RevisionMeta(value: unknown): V2RevisionMeta {
  const body = record(value, "revision metadata");
  return {
    revision: positiveSafeInteger(field(body, "revision"), "revision"),
    noteId: nonEmptyString(field(body, "noteId"), "noteId"),
    kind: oneOf(field(body, "kind"), "kind", ["baseline", "create", "import", "save", "rename", "delete", "external_edit", "external_rename", "external_delete", "conflict_recovery"]),
    source: oneOf(field(body, "source"), "source", ["user", "import", "external", "repair"]),
    sourceHash: field(body, "sourceHash") === null
      ? null
      : hash(field(body, "sourceHash"), "sourceHash", "source"),
    createdAtMs: integer(field(body, "createdAtMs"), "createdAtMs"),
  };
}

function decodeV2LinkedNote(value: unknown): V2LinkedNote {
  const body = record(value, "linked note");
  return {
    noteId: nonEmptyString(field(body, "noteId"), "noteId"),
    path: nonEmptyString(field(body, "path"), "path"),
    title: string(field(body, "title"), "title"),
  };
}

function decodeV2NoteLinksResponse(value: unknown): V2NoteLinksResponse {
  const body = record(value, "note links");
  return {
    backlinks: array(field(body, "backlinks"), "backlinks").map((item) => {
      const backlink = record(item, "backlink");
      return {
        note: decodeV2LinkedNote(field(backlink, "note")),
        mentions: array(field(backlink, "mentions"), "mentions").map((mention) => string(mention, "mention")),
      };
    }),
    outgoing: array(field(body, "outgoing"), "outgoing").map(decodeV2LinkedNote),
  };
}

function decodeV2NotePreview(value: unknown): V2NotePreview {
  const body = record(value, "note preview");
  return {
    noteId: nonEmptyString(field(body, "noteId"), "noteId"),
    preview: string(field(body, "preview"), "preview"),
  };
}

function decodeV2RevisionMetaArray(value: unknown): V2RevisionMeta[] {
  return array(value, "revisions").map(decodeV2RevisionMeta);
}

function decodeV2RevisionDocument(value: unknown): V2RevisionDocument {
  const body = record(value, "revision document");
  return {
    revision: decodeV2RevisionMeta(field(body, "revision")),
    content: string(field(body, "content"), "content"),
  };
}

function decodeSettings(value: unknown): Settings {
  const body = record(value, "settings");
  return {
    excludedFolders: array(field(body, "excludedFolders"), "excludedFolders")
      .map((folder) => string(folder, "excluded folder")),
    searchTitleWeight: finiteNumber(field(body, "searchTitleWeight"), "searchTitleWeight", 0),
    searchHeadingWeight: finiteNumber(field(body, "searchHeadingWeight"), "searchHeadingWeight", 0),
    searchTagWeight: finiteNumber(field(body, "searchTagWeight"), "searchTagWeight", 0),
    searchContentWeight: finiteNumber(field(body, "searchContentWeight"), "searchContentWeight", 0),
    recencyBoost: finiteNumber(field(body, "recencyBoost"), "recencyBoost", 0),
    autosaveDelayMs: integer(field(body, "autosaveDelayMs"), "autosaveDelayMs"),
    undoStackMax: positiveSafeInteger(field(body, "undoStackMax"), "undoStackMax"),
    imageWebpQuality: finiteNumber(field(body, "imageWebpQuality"), "imageWebpQuality", 0, 1),
  };
}

function decodeSearchStatus(value: unknown) {
  const body = record(value, "search status");
  return {
    dirty: boolean(field(body, "dirty"), "dirty"),
    degraded: boolean(field(body, "degraded"), "degraded"),
  };
}

function decodeV2SettingsResponse(value: unknown): V2SettingsResponse {
  const body = record(value, "settings response");
  return {
    mutationId: mutationId(field(body, "mutationId")),
    settings: decodeSettings(field(body, "settings")),
  };
}

function decodeV2SearchResponse(value: unknown): V2SearchResponse {
  const body = record(value, "search response");
  const hits = array(field(body, "hits"), "hits").map((item) => {
    const hit = record(item, "search hit");
    const excerpt = string(field(hit, "excerpt"), "excerpt");
    const excerptRanges = array(field(hit, "excerptRanges"), "excerptRanges")
      .map((range) => decodeRange(range, "excerpt", excerpt.length));
    const rawSourceRange = field(hit, "sourceRange");
    const sourceRange = rawSourceRange === null ? null : decodeRange(rawSourceRange, "source");
    return {
      identity: decodeSearchIdentity(field(hit, "identity")),
      title: string(field(hit, "title"), "title"),
      path: string(field(hit, "path"), "path"),
      score: finiteNumber(field(hit, "score"), "score"),
      excerpt,
      excerptRanges,
      sourceRange,
    };
  });
  const coverage = record(field(body, "overlayCoverage"), "overlay coverage");
  const status = string(field(coverage, "status"), "overlay coverage status");
  const overlayCoverage = status === "complete"
    ? { status }
    : status === "partial"
    ? { status, skippedNoteCount: integer(field(coverage, "skippedNoteCount"), "skippedNoteCount") }
    : fail<V2SearchResponse["overlayCoverage"]>("Unknown overlay coverage state");
  return { hits, overlayCoverage } as V2SearchResponse;
}

function decodeSearchIdentity(value: unknown): V2SearchResponse["hits"][number]["identity"] {
  const body = record(value, "search hit identity");
  const kind = string(field(body, "kind"), "identity kind");
  if (kind === "canonical") {
    return {
      kind,
      noteId: nonEmptyString(field(body, "noteId"), "noteId"),
      revision: positiveSafeInteger(field(body, "revision"), "revision"),
      sourceHash: hash(field(body, "sourceHash"), "sourceHash", "source"),
    };
  }
  if (kind === "savedOverlay") {
    return {
      kind,
      noteId: nonEmptyString(field(body, "noteId"), "noteId"),
      localRevision: integer(field(body, "localRevision"), "localRevision"),
      sourceHash: hash(field(body, "sourceHash"), "sourceHash", "source"),
    };
  }
  if (kind === "newLocalDraft") {
    return {
      kind,
      localId: nonEmptyString(field(body, "localId"), "localId"),
      localRevision: integer(field(body, "localRevision"), "localRevision"),
      sourceHash: hash(field(body, "sourceHash"), "sourceHash", "source"),
    };
  }
  return fail("Unknown search hit identity");
}

function decodeRange(value: unknown, name: string, max?: number) {
  const body = record(value, `${name} range`);
  const startUtf16 = integer(field(body, "startUtf16"), "startUtf16");
  const endUtf16 = integer(field(body, "endUtf16"), "endUtf16");
  if (endUtf16 < startUtf16 || (max !== undefined && endUtf16 > max)) {
    throw new V2ProtocolError(`Invalid ${name} UTF-16 range`);
  }
  return { startUtf16, endUtf16 };
}

function decodeV2ImageUploadResponse(value: unknown): V2ImageUploadResponse {
  const body = record(value, "image response");
  return {
    mutationId: mutationId(field(body, "mutationId")),
    name: nonEmptyString(field(body, "name"), "name"),
    markdown: string(field(body, "markdown"), "markdown"),
  };
}

function decodeV2EventStreamMessage(data: string): V2ServerEvent {
  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    throw new V2ProtocolError("SSE message is not valid JSON");
  }
  return decodeV2ServerEvent(value);
}

function connectEvents(
  fetcher: typeof fetch,
  wait: V2Transport["wait"],
  vaultPath: string,
  baseHeaders: HeadersInit,
  expectedVaultId: string,
  startingVersion: number,
  handlers: V2EventHandlers,
): V2EventSubscription {
  let cursor = integer(startingVersion, "after event version");
  let closed = false;
  let attempt = 0;
  const controller = new AbortController();
  const stop = () => {
    if (!closed) {
      closed = true;
      controller.abort();
    }
  };
  void (async () => {
    while (!closed) {
      try {
        const headers = new Headers(baseHeaders);
        headers.set("Accept", "text/event-stream");
        const response = await fetcher(
          `${vaultPath}/events?after=${encodeURIComponent(String(cursor))}`,
          { headers, signal: controller.signal },
        );
        checkResponseHeaders(response.headers);
        if (!response.ok) {
          await throwHttpError(response);
        }
        if (response.body === null) {
          throw new V2ProtocolError("SSE response has no body");
        }
        attempt = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!closed) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          const messages = takeSseMessages(buffer);
          buffer = messages.remainder;
          for (const data of messages.data) {
            const event = decodeV2EventStreamMessage(data);
            if (event.eventVersion <= cursor) {
              continue;
            }
            if (event.resyncRequired) {
              await handlers.onResync(
                await fetchVaultSnapshot(fetcher, vaultPath, baseHeaders, expectedVaultId, event.eventVersion),
              );
            }
            if (!event.resyncRequired) {
              handlers.onEvent(event);
            }
            cursor = event.eventVersion;
          }
        }
        if (!closed) {
          attempt += 1;
          await wait(reconnectDelay(attempt), controller.signal);
        }
      } catch (error) {
        if (closed || controller.signal.aborted) {
          break;
        }
        handlers.onError?.(error);
        if (!isRetryableV2Error(error)) {
          stop();
          break;
        }
        attempt += 1;
        try {
          await wait(reconnectDelay(attempt), controller.signal);
        } catch (waitError) {
          if (!controller.signal.aborted) {
            handlers.onError?.(waitError);
            stop();
          }
        }
      }
    }
  })();
  return { close: stop };
}

async function fetchVaultSnapshot(
  fetcher: typeof fetch,
  vaultPath: string,
  baseHeaders: HeadersInit,
  expectedVaultId: string,
  eventVersion: number,
): Promise<V2VaultSnapshot> {
  const bootstrap = await getJson(fetcher, `${vaultPath}/bootstrap`, decodeV2VaultBootstrap, baseHeaders);
  if (bootstrap.vault.vaultId !== expectedVaultId) {
    throw new V2ProtocolError("Resync bootstrap identity does not match the subscribed vault");
  }
  const notes = await getJson(fetcher, `${vaultPath}/notes`, decodeV2NoteMetaArray, baseHeaders);
  return { bootstrap, notes, eventVersion };
}

function takeSseMessages(buffer: string): { data: string[]; remainder: string } {
  const normalized = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const blocks = normalized.split("\n\n");
  const remainder = blocks.pop() ?? "";
  const data = blocks.flatMap((block) => {
    const lines = block.split("\n");
    const values = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    return values.length === 0 ? [] : [values.join("\n")];
  });
  return { data, remainder };
}

async function throwHttpError(response: Response): Promise<never> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new V2ProtocolError(`HTTP ${response.status} returned an invalid error body`);
  }
  const decoded = decodeV2ApiErrorResponse(body);
  throw new V2ApiError(`V2 API request failed with HTTP ${response.status}`, response.status, decoded.error);
}

export function isRetryableV2Error(error: unknown): boolean {
  if (error instanceof V2ApiError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError");
}

function reconnectDelay(attempt: number): number {
  return Math.min(1000 * 2 ** Math.min(attempt - 1, 4), 15000);
}

function waitForReconnect(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted", "AbortError"));
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function assertNoteId(meta: V2NoteMeta, expected: string): void {
  if (meta.noteId !== expected) {
    throw new V2ProtocolError("Note response identity does not match the request");
  }
}

function assertMutationIdentity(response: V2MutationResponse, expectedNoteId: string): void {
  const { outcome } = response;
  if ((outcome.state === "accepted" && outcome.result !== null && outcome.result.noteId !== expectedNoteId) ||
    (outcome.state === "conflict" &&
      (outcome.current.meta.noteId !== expectedNoteId || outcome.draft.noteId !== expectedNoteId))) {
    throw new V2ProtocolError("Mutation response note identity does not match the request");
  }
}

function assertMutationId(response: V2MutationResponse, expected: string): void {
  if (response.mutationId !== expected) {
    throw new V2ProtocolError("Mutation response id does not match the request");
  }
}

function mutationId(value: unknown): string {
  const id = nonEmptyString(value, "mutationId");
  assertMutationIdValue(id);
  return id;
}

function assertMutationIdValue(value: string): void {
  if (new TextEncoder().encode(value).length > 128) {
    throw new TypeError("mutationId exceeds 128 UTF-8 bytes");
  }
}

function hash(value: unknown, name: string, family: "source" | "disk"): string {
  const result = string(value, name);
  const prefix = family === "source" ? "blake3-v3:" : "blake3-v2:";
  if (!new RegExp(`^${prefix}[0-9a-f]{64}$`).test(result)) {
    throw new V2ProtocolError(`${name} is not a supported hash`);
  }
  return result;
}

function hashVersion(hash: string, version: number, family: "source" | "disk"): number {
  const expected = family === "source" ? 3 : 2;
  const prefix = family === "source" ? "blake3-v3:" : "blake3-v2:";
  if (version !== expected || !hash.startsWith(prefix)) {
    throw new V2ProtocolError("Hash format version does not match its value");
  }
  return version;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new V2ProtocolError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function field(body: Record<string, unknown>, name: string): unknown {
  return body[name];
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new V2ProtocolError(`${name} must be an array`);
  }
  return value;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new V2ProtocolError(`${name} must be a string`);
  }
  return value;
}

function nonEmptyString(value: unknown, name: string): string {
  const result = string(value, name);
  if (result.length === 0) {
    throw new V2ProtocolError(`${name} must not be empty`);
  }
  return result;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new V2ProtocolError(`${name} must be a boolean`);
  }
  return value;
}

function integer(value: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new V2ProtocolError(`${name} is outside the safe integer range`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, name: string): number {
  return integer(value, name, 1);
}

function finiteNumber(value: unknown, name: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new V2ProtocolError(`${name} is outside the supported numeric range`);
  }
  return value;
}

function oneOf<const Values extends readonly string[]>(value: unknown, name: string, values: Values): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new V2ProtocolError(`${name} has an unknown value`);
  }
  return value as Values[number];
}

function fail<T>(message: string): T {
  throw new V2ProtocolError(message);
}
