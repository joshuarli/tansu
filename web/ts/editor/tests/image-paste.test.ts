import { EditorView } from "@codemirror/view";
import { Transaction } from "@codemirror/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodeMirrorEditor, type EditorHandle } from "../codemirror-adapter.js";
import type { EditorImagePasteState, EditorImageUploadRequest, EditorImageUploadResult } from "../tansu-extensions.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type MountedEditor = {
  container: HTMLElement;
  editor: EditorHandle;
  session: ReturnType<EditorHandle["createSession"]>;
  view: EditorView;
  dispose(): void;
};

const mounted: MountedEditor[] = [];
const restores: Array<() => void> = [];

function installImageApis() {
  const bitmapClose = vi.fn();
  const canvasConvert = vi.fn(async ({ type }: ImageEncodeOptions) =>
    new Blob(["webp"], { type: type ?? "image/webp" })
  );
  const bitmapDescriptor = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  const canvasDescriptor = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: vi.fn(async () => ({ width: 12, height: 8, close: bitmapClose })),
    writable: true,
  });
  Object.defineProperty(globalThis, "OffscreenCanvas", {
    configurable: true,
    value: vi.fn(function () {
      return {
        getContext: () => ({ drawImage: vi.fn() }),
        convertToBlob: canvasConvert,
      };
    }),
    writable: true,
  });

  const createUrl = vi.fn(() => "blob:image-preview");
  const revokeUrl = vi.fn();
  const createUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const revokeUrlDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createUrl, writable: true });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeUrl, writable: true });

  restores.push(() => {
    if (bitmapDescriptor) Object.defineProperty(globalThis, "createImageBitmap", bitmapDescriptor);
    else Reflect.deleteProperty(globalThis, "createImageBitmap");
    if (canvasDescriptor) Object.defineProperty(globalThis, "OffscreenCanvas", canvasDescriptor);
    else Reflect.deleteProperty(globalThis, "OffscreenCanvas");
    if (createUrlDescriptor) Object.defineProperty(URL, "createObjectURL", createUrlDescriptor);
    else Reflect.deleteProperty(URL, "createObjectURL");
    if (revokeUrlDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeUrlDescriptor);
    else Reflect.deleteProperty(URL, "revokeObjectURL");
  });

  return { bitmapClose, canvasConvert, createUrl, revokeUrl };
}

function mountEditor(
  source: string,
  config: Parameters<typeof createCodeMirrorEditor>[1],
  noteId = "note-a",
): MountedEditor {
  const container = document.createElement("div");
  document.body.append(container);
  const editor = createCodeMirrorEditor(container, config);
  const session = editor.createSession(noteId, source);
  editor.attachSession(session);
  const root = container.querySelector<HTMLElement>(".cm-editor");
  const view = root === null ? null : EditorView.findFromDOM(root);
  if (view === null) throw new Error("EditorView was not mounted");
  const item = {
    container,
    editor,
    session,
    view,
    dispose() {
      editor.dispose();
      container.remove();
    },
  };
  mounted.push(item);
  return item;
}

function pasteImage(view: EditorView, type = "image/png"): ClipboardEvent {
  const extension = type.split("/").at(-1) ?? "bin";
  const file = new File(["image-bytes"], `pasted.${extension}`, { type });
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: [{ type: "image/png", getAsFile: () => file }],
      getData: () => "",
    } as unknown as DataTransfer,
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}

function terminalState(states: Deferred<EditorImagePasteState>, state: EditorImagePasteState): void {
  if (state.status !== "uploading") states.resolve(state);
}

describe("CodeMirror image paste uploads", () => {
  afterEach(() => {
    for (const item of mounted.splice(0)) item.dispose();
    for (const restore of restores.splice(0)) restore();
    vi.restoreAllMocks();
  });

  it("inserts into the captured session and selection after switching notes", async () => {
    const { bitmapClose, canvasConvert, createUrl, revokeUrl } = installImageApis();
    const requestSeen = deferred<EditorImageUploadRequest>();
    const response = deferred<EditorImageUploadResult>();
    const finished = deferred<EditorImagePasteState>();
    const states: EditorImagePasteState[] = [];
    const { editor, session: first, view } = mountEditor("before after", {
      uploadPastedImage(request) {
        requestSeen.resolve(request);
        return response.promise;
      },
      onImagePasteStateChange(state) {
        states.push(state);
        terminalState(finished, state);
      },
    });

    view.dispatch({ selection: { anchor: 7 } });
    const event = pasteImage(view);
    const request = await requestSeen.promise;
    // oxlint-disable-next-line vitest/prefer-to-be-truthy -- Keep the exact boolean result.
    expect(event.defaultPrevented).toBe(true);
    expect(request).toMatchObject({
      noteId: "note-a",
      revision: 0,
      selection: { anchor: 7, head: 7 },
      image: { type: "image/webp" },
    });
    expect(states[0]).toMatchObject({ status: "uploading", previewUrl: "blob:image-preview" });
    expect(canvasConvert).toHaveBeenCalledWith({ type: "image/webp", quality: 0.85 });
    expect(bitmapClose).toHaveBeenCalledTimes(1);
    expect(createUrl).toHaveBeenCalledTimes(1);

    view.dispatch({ selection: { anchor: 0 } });
    const second = editor.createSession("note-b", "another note");
    editor.attachSession(second);
    response.resolve({ name: "z-images/photo.webp", markdown: "![[z-images/photo.webp]]" });
    await expect(finished.promise).resolves.toMatchObject({ status: "inserted", noteId: "note-a", revision: 0 });

    expect(editor.getSnapshot()?.source).toBe("another note");
    editor.attachSession(first);
    expect(editor.getSnapshot()).toMatchObject({
      source: "before ![[z-images/photo.webp]]after",
      revision: 1,
      dirty: true,
    });
    editor.undo();
    expect(editor.getSnapshot()?.source).toBe("before after");
    expect(states.map((state) => state.status)).toStrictEqual(["uploading", "inserted"]);
    expect(revokeUrl).toHaveBeenCalledWith("blob:image-preview");
  });

  it("uploads existing WebP bytes without re-encoding them", async () => {
    const { bitmapClose, canvasConvert } = installImageApis();
    const requestSeen = deferred<EditorImageUploadRequest>();
    const finished = deferred<EditorImagePasteState>();
    const { editor, view } = mountEditor("text", {
      async uploadPastedImage(request) {
        requestSeen.resolve(request);
        return { name: "z-images/photo.webp", markdown: "![[z-images/photo.webp]]" };
      },
      onImagePasteStateChange(state) {
        terminalState(finished, state);
      },
    });

    pasteImage(view, "image/webp");
    const request = await requestSeen.promise;
    expect(request.image.type).toBe("image/webp");
    await expect(request.image.text()).resolves.toBe("image-bytes");
    await expect(finished.promise).resolves.toMatchObject({ status: "inserted" });
    expect(bitmapClose).not.toHaveBeenCalled();
    expect(canvasConvert).not.toHaveBeenCalled();
    expect(editor.getSnapshot()?.source).toBe("![[z-images/photo.webp]]text");
  });

  it("aborts and rejects a response after the source revision changes", async () => {
    const { revokeUrl } = installImageApis();
    const requestSeen = deferred<EditorImageUploadRequest>();
    const response = deferred<EditorImageUploadResult>();
    const finished = deferred<EditorImagePasteState>();
    const { editor, view } = mountEditor("text", {
      uploadPastedImage(request) {
        requestSeen.resolve(request);
        return response.promise;
      },
      onImagePasteStateChange(state) {
        terminalState(finished, state);
      },
    });

    view.dispatch({ selection: { anchor: 4 } });
    pasteImage(view);
    const request = await requestSeen.promise;
    view.dispatch({
      changes: { from: 4, insert: " changed" },
      annotations: Transaction.userEvent.of("input.type"),
    });
    // oxlint-disable-next-line vitest/prefer-to-be-truthy -- Keep the exact boolean result.
    expect(request.signal.aborted).toBe(true);
    await expect(finished.promise).resolves.toMatchObject({ status: "stale", noteId: "note-a", revision: 0 });
    expect(revokeUrl).toHaveBeenCalledWith("blob:image-preview");
    response.resolve({ name: "z-images/photo.webp", markdown: "![[z-images/photo.webp]]" });
    expect(editor.getSnapshot()).toMatchObject({ source: "text changed", revision: 1 });
  });

  it("reports upload failures and keeps the authored source", async () => {
    const { bitmapClose, revokeUrl } = installImageApis();
    const finished = deferred<EditorImagePasteState>();
    const { editor, view } = mountEditor("text", {
      async uploadPastedImage() {
        throw new Error("upload rejected");
      },
      onImagePasteStateChange(state) {
        terminalState(finished, state);
      },
    });

    view.dispatch({ selection: { anchor: 4 } });
    pasteImage(view);
    await expect(finished.promise).resolves.toMatchObject({ status: "failed", message: "upload rejected" });
    expect(editor.getSnapshot()?.source).toBe("text");
    expect(bitmapClose).toHaveBeenCalledTimes(1);
    expect(revokeUrl).toHaveBeenCalledWith("blob:image-preview");
  });

  it("rejects upload results outside the WebP vault asset contract", async () => {
    installImageApis();
    const finished = deferred<EditorImagePasteState>();
    const { editor, view } = mountEditor("text", {
      async uploadPastedImage() {
        return { name: "z-images/photo.png", markdown: "![[z-images/photo.png]]" };
      },
      onImagePasteStateChange(state) {
        terminalState(finished, state);
      },
    });

    view.dispatch({ selection: { anchor: 4 } });
    pasteImage(view);
    await expect(finished.promise).resolves.toMatchObject({ status: "failed" });
    expect(editor.getSnapshot()?.source).toBe("text");
  });

  it("aborts an upload when the captured session becomes read-only", async () => {
    installImageApis();
    const requestSeen = deferred<EditorImageUploadRequest>();
    const response = deferred<EditorImageUploadResult>();
    const finished = deferred<EditorImagePasteState>();
    const { editor, view } = mountEditor("text", {
      uploadPastedImage(request) {
        requestSeen.resolve(request);
        return response.promise;
      },
      onImagePasteStateChange(state) {
        terminalState(finished, state);
      },
    });

    pasteImage(view);
    const request = await requestSeen.promise;
    editor.updateConfiguration({ readOnly: true });
    // oxlint-disable-next-line vitest/prefer-to-be-truthy -- Keep the exact boolean result.
    expect(request.signal.aborted).toBe(true);
    await expect(finished.promise).resolves.toMatchObject({ status: "stale", noteId: "note-a", revision: 0 });
    response.resolve({ name: "z-images/photo.webp", markdown: "![[z-images/photo.webp]]" });
    expect(editor.getSnapshot()?.source).toBe("text");
  });

  it("aborts outstanding work and revokes the preview URL on dispose", async () => {
    const { revokeUrl } = installImageApis();
    const requestSeen = deferred<EditorImageUploadRequest>();
    const response = deferred<EditorImageUploadResult>();
    const states: EditorImagePasteState[] = [];
    const { editor, view } = mountEditor("text", {
      uploadPastedImage(request) {
        requestSeen.resolve(request);
        return response.promise;
      },
      onImagePasteStateChange(state) {
        states.push(state);
      },
    });

    pasteImage(view);
    const request = await requestSeen.promise;
    editor.dispose();
    // oxlint-disable-next-line vitest/prefer-to-be-truthy -- Keep the exact boolean result.
    expect(request.signal.aborted).toBe(true);
    expect(revokeUrl).toHaveBeenCalledWith("blob:image-preview");
    response.resolve({ name: "z-images/photo.webp", markdown: "![[z-images/photo.webp]]" });
    await Promise.resolve();
    await Promise.resolve();
    expect(states.map((state) => state.status)).toStrictEqual(["uploading"]);
  });
});
