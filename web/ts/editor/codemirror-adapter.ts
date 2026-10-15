import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { indentWithTab, defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
} from "@codemirror/state";
import {
  drawSelection,
  Decoration,
  type DecorationSet,
  EditorView,
  highlightActiveLine,
  keymap,
  rectangularSelection,
} from "@codemirror/view";
import { atomicEditorTheme, atomicMarkdownSyntax } from "./vendor/atomic/atomic-theme.js";
import { autoCloseCodeFence, extendEmphasisPair, startAsteriskList } from "./vendor/atomic/edit-helpers.js";
import { highlightMarkdown } from "./vendor/atomic/highlight.js";
import { imageBlocks } from "./vendor/atomic/image-blocks.js";
import { inlinePreview } from "./vendor/atomic/inline-preview.js";
import { readOnlyExtension, readOnlyFacet } from "./vendor/atomic/read-only.js";
import { tables } from "./vendor/atomic/table-widget.js";
import { wikiLinks } from "./vendor/atomic/wiki-links.js";
import { calloutDecoration } from "./callout-decoration.js";
import { sanitizeHtmlToMarkdown } from "./clipboard.js";
import { findLiteral, outlineFromSyntaxTree, type FindMatch, type Outline, type OutlineHeading } from "./source-navigation.js";
import { tagsSourceEdit } from "./tag-source.js";
import {
  createCalloutExtension,
  type EditorChange,
  type EditorConfig,
  type EditorExtension,
  type EditorImagePasteSelection,
  type EditorImagePasteState,
  type EditorImageUploadRequest,
  type EditorImageUploadResult,
} from "./tansu-extensions.js";
import { resolveWikiTarget, suggestWikiTargets } from "./wiki-target.js";
import { wikiImages } from "./wiki-images.js";
import {
  toggleBold,
  toggleHeading,
  toggleHighlight,
  toggleItalic,
  toggleStrikethrough,
  type FormatResult,
} from "./format-ops.js";

const transactionOrigin = Annotation.define<EditorOrigin>();

type EditorOrigin = "load" | "modeChange" | "externalReload" | "userEdit";
export type EditorMode = "live" | "source";
export type FormatCommand = "bold" | "italic" | "highlight" | "strikethrough" | "heading";

declare const editorSessionBrand: unique symbol;

export type EditorSession = {
  readonly noteId: string;
  readonly [editorSessionBrand]: true;
};

export type EditorSelectionSnapshot = {
  anchor: number;
  head: number;
};

export type EditorScrollSnapshot = {
  top: number;
  left: number;
};

export type EditorSnapshot = {
  noteId: string;
  source: string;
  revision: number;
  selection: EditorSelectionSnapshot;
  mode: EditorMode;
  readOnly: boolean;
  scroll: EditorScrollSnapshot;
  dirty: boolean;
};

export type ReloadResult =
  | { kind: "reloaded"; revision: number }
  | { kind: "unchanged"; revision: number }
  | { kind: "dirty"; revision: number };

export type SessionOptions = {
  mode?: EditorMode;
  readOnly?: boolean;
};

export type EditorHandle = {
  createSession(noteId: string, source: string, options?: SessionOptions): EditorSession;
  attachSession(session: EditorSession): void;
  detachSession(): EditorSession | null;
  dispose(): void;
  focus(): void;
  getSnapshot(): EditorSnapshot | null;
  markSaved(session: EditorSession, revision: number): boolean;
  reloadIfClean(session: EditorSession, source: string): ReloadResult;
  setMode(mode: EditorMode): void;
  updateConfiguration(partial: Partial<EditorConfig>): void;
  revealSelection(selection: EditorSelectionSnapshot): boolean;
  find(query: string): readonly FindMatch[];
  setFindHighlights(highlights: { matches: readonly FindMatch[]; selected: FindMatch | null }): void;
  revealFindMatch(match: FindMatch): boolean;
  outline(): Outline;
  formatSelection(command: FormatCommand): void;
  updateTags(tags: readonly string[]): boolean;
  undo(): boolean;
  redo(): boolean;
};

type SessionData = {
  owner: symbol;
  state: EditorState;
  revision: number;
  dirty: boolean;
  mode: EditorMode;
  readOnly: boolean;
  sourceCache: string;
  sourceCacheRevision: number;
  scroll: EditorScrollSnapshot;
};

type FindHighlightState = {
  matches: readonly FindMatch[];
  selected: FindMatch | null;
  decorations: DecorationSet;
};

const setFindHighlightsEffect = StateEffect.define<{
  matches: readonly FindMatch[];
  selected: FindMatch | null;
}>();

const findHighlightField = StateField.define<FindHighlightState>({
  create: () => ({ matches: [], selected: null, decorations: Decoration.none }),
  update(value, transaction) {
    let matches = value.matches;
    let selected = value.selected;
    let decorations = value.decorations;
    if (transaction.docChanged) {
      matches = matches
        .map((match) => ({
          from: transaction.changes.mapPos(match.from, 1),
          to: transaction.changes.mapPos(match.to, -1),
        }))
        .filter((match) => match.from < match.to);
      selected = selected === null
        ? null
        : {
          from: transaction.changes.mapPos(selected.from, 1),
          to: transaction.changes.mapPos(selected.to, -1),
        };
      if (selected !== null && selected.from >= selected.to) selected = null;
      decorations = decorations.map(transaction.changes);
    }
    for (const effect of transaction.effects) {
      if (!effect.is(setFindHighlightsEffect)) continue;
      matches = effect.value.matches;
      selected = effect.value.selected;
      decorations = findMatchDecorations(matches, selected);
    }
    if (matches === value.matches && selected === value.selected && decorations === value.decorations) return value;
    return { matches, selected, decorations };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

function findMatchDecorations(matches: readonly FindMatch[], selected: FindMatch | null): DecorationSet {
  return Decoration.set(
    matches.map((match) =>
      Decoration.mark({
        class: selected !== null && match.from === selected.from && match.to === selected.to
          ? "cm-atomic-find-match cm-atomic-find-match-active"
          : "cm-atomic-find-match",
      }).range(match.from, match.to)
    ),
    true,
  );
}

type PendingImagePaste = {
  uploadId: number;
  session: EditorSession;
  data: SessionData;
  revision: number;
  selection: EditorImagePasteSelection;
  file: File;
  previewUrl: string;
  controller: AbortController;
  task: Promise<void> | null;
  finished: boolean;
};

type ImagePasteOutcome =
  | { status: "inserted" | "stale" }
  | { status: "failed"; message: string };

const sessions = new WeakMap<EditorSession, SessionData>();
const defaultCallout = createCalloutExtension();

function resolveMarkdownImageUrl(
  source: string,
  resolveVaultAsset: ((name: string) => string | null) | undefined,
): string | null {
  if (resolveVaultAsset === undefined) return source;
  if (source.startsWith("//")) return source;
  try {
    const protocol = new URL(source).protocol;
    return protocol === "http:" || protocol === "https:" ? source : null;
  } catch {
    return resolveVaultAsset(source);
  }
}

function sessionData(session: EditorSession, owner: symbol): SessionData {
  const data = sessions.get(session);
  if (data === undefined || data.owner !== owner) {
    throw new TypeError("Editor session belongs to another editor");
  }
  return data;
}

function editorExtensions(config: EditorConfig, live: boolean): Extension[] {
  const extensions: Extension[] = [];
  if (!live) return extensions;

  const configured = config.extensions ?? [];
  const imageExtensions = configured.filter(
    (extension): extension is Extract<EditorExtension, { kind: "wiki-images" }> =>
      extension.kind === "wiki-images",
  );
  const resolveVaultAsset = imageExtensions[imageExtensions.length - 1]?.resolveUrl;
  const calloutExtensions = configured.filter(
    (extension): extension is Extract<EditorExtension, { kind: "callouts" }> =>
      extension.kind === "callouts",
  );
  const callout = calloutExtensions[calloutExtensions.length - 1] ?? defaultCallout;
  const wikiConfig = {
    suggest: async (query: string) => suggestWikiTargets(query, config.wikiNotes?.() ?? []),
    resolve: async (target: string) => {
      const result = resolveWikiTarget(
        target,
        config.currentNotePath?.() ?? "",
        config.wikiNotes?.() ?? [],
      );
      if (result.kind === "resolved") {
        return { target, label: result.note.title, status: "resolved" as const };
      }
      if (result.kind === "ambiguous") return { target, label: target, status: "unresolved" as const };
      return { target, label: target, status: result.kind === "missing" ? "missing" as const : "unresolved" as const };
    },
    onOpen: (target: string) => {
      const result = resolveWikiTarget(
        target,
        config.currentNotePath?.() ?? "",
        config.wikiNotes?.() ?? [],
      );
      if (result.kind === "resolved") config.onWikiNoteOpen?.(result.note.noteId);
    },
  };

  for (const extension of imageExtensions) {
    extensions.push(wikiImages({ resolveUrl: extension.resolveUrl }));
  }
  extensions.push(
    inlinePreview(config.onLinkOpen ? { onLinkClick: config.onLinkOpen } : {}),
    imageBlocks((source) => resolveMarkdownImageUrl(source, resolveVaultAsset)),
    tables(config.onLinkOpen ? { onLinkClick: config.onLinkOpen } : {}),
    calloutDecoration({ icons: callout.icons }),
  );
  if (configured.some((extension) => extension.kind === "wiki-links")) {
    extensions.push(wikiLinks(wikiConfig));
  }
  return extensions;
}

function sameRecord(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) =>
    Object.hasOwn(right, key) && left[key] === right[key]
  );
}

function sameEditorExtensionInputs(left: EditorConfig, right: EditorConfig): boolean {
  const leftExtensions = left.extensions ?? [];
  const rightExtensions = right.extensions ?? [];
  const leftImages = leftExtensions.filter(
    (extension): extension is Extract<EditorExtension, { kind: "wiki-images" }> => extension.kind === "wiki-images",
  );
  const rightImages = rightExtensions.filter(
    (extension): extension is Extract<EditorExtension, { kind: "wiki-images" }> => extension.kind === "wiki-images",
  );
  if (leftImages.length !== rightImages.length || leftImages.some((extension, index) =>
    extension.resolveUrl !== rightImages[index]?.resolveUrl
  )) return false;

  const leftCallouts = leftExtensions.filter(
    (extension): extension is Extract<EditorExtension, { kind: "callouts" }> => extension.kind === "callouts",
  );
  const rightCallouts = rightExtensions.filter(
    (extension): extension is Extract<EditorExtension, { kind: "callouts" }> => extension.kind === "callouts",
  );
  const leftCallout = leftCallouts[leftCallouts.length - 1] ?? defaultCallout;
  const rightCallout = rightCallouts[rightCallouts.length - 1] ?? defaultCallout;
  if (!sameRecord(leftCallout.icons, rightCallout.icons)) return false;

  const leftWikiLinks = leftExtensions.some((extension) => extension.kind === "wiki-links");
  const rightWikiLinks = rightExtensions.some((extension) => extension.kind === "wiki-links");
  return leftWikiLinks === rightWikiLinks && left.onLinkOpen === right.onLinkOpen &&
    (!leftWikiLinks || (
      left.currentNotePath === right.currentNotePath &&
      left.wikiNotes === right.wikiNotes &&
      left.onWikiNoteOpen === right.onWikiNoteOpen
    ));
}

function editorKeymap(config: EditorConfig): Extension {
  return keymap.of([
    { key: "Mod-s", run: () => { config.onSave?.(); return true; } },
    { key: "Mod-f", run: () => { config.onFindRequested?.(); return true; } },
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...historyKeymap,
    indentWithTab,
  ]);
}

function createState(
  source: string,
  mode: EditorMode,
  readOnly: boolean,
  config: EditorConfig,
  modeCompartment: Compartment,
  readOnlyCompartment: Compartment,
  keymapCompartment: Compartment,
  updateListener: Extension,
  clipboardHandler: Extension,
  pasteHandler: Extension,
): EditorState {
  return EditorState.create({
    doc: source,
    extensions: [
      history(),
      findHighlightField,
      markdown({ base: markdownLanguage, codeLanguages: [], extensions: [highlightMarkdown] }),
      atomicEditorTheme,
      atomicMarkdownSyntax,
      EditorState.allowMultipleSelections.of(true),
      EditorState.transactionFilter.of((transaction) => {
        if (!transaction.docChanged || !transaction.startState.facet(readOnlyFacet)) return transaction;
        const origin = transaction.annotation(transactionOrigin);
        return origin === "load" || origin === "externalReload" ? transaction : [];
      }),
      EditorState.transactionExtender.of((transaction) =>
        transaction.docChanged && transaction.annotation(transactionOrigin) === undefined
          ? { annotations: transactionOrigin.of("userEdit") }
          : null,
      ),
      modeCompartment.of(editorExtensions(config, mode === "live")),
      readOnlyCompartment.of(readOnlyExtension(readOnly)),
      drawSelection(),
      rectangularSelection(),
      highlightActiveLine(),
      EditorView.lineWrapping,
      closeBrackets(),
      startAsteriskList,
      extendEmphasisPair,
      autoCloseCodeFence,
      keymapCompartment.of(editorKeymap(config)),
      updateListener,
      clipboardHandler,
      pasteHandler,
    ],
  });
}

export function createCodeMirrorEditor(container: HTMLElement, initialConfig: EditorConfig = {}): EditorHandle {
  let config: EditorConfig = { ...initialConfig };
  let activeSession: EditorSession | null = null;
  let disposed = false;
  const owner = Symbol("editor");
  const modeCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();
  const keymapCompartment = new Compartment();
  const imagePastes = new Map<number, PendingImagePaste>();
  let nextImagePasteId = 1;

  function notifyImagePasteState(state: EditorImagePasteState): void {
    if (disposed) return;
    try {
      config.onImagePasteStateChange?.(state);
    } catch (error) {
      console.error(error);
    }
  }

  function imagePasteContext(paste: PendingImagePaste): Pick<EditorImagePasteState, "uploadId" | "noteId" | "revision" | "selection"> {
    return {
      uploadId: paste.uploadId,
      noteId: paste.session.noteId,
      revision: paste.revision,
      selection: { ...paste.selection },
    };
  }

  function notifyImagePaste(paste: PendingImagePaste, outcome: ImagePasteOutcome): void {
    notifyImagePasteState({ ...imagePasteContext(paste), ...outcome });
  }

  function markImagePasteFinished(paste: PendingImagePaste): boolean {
    if (paste.finished) return false;
    paste.finished = true;
    URL.revokeObjectURL(paste.previewUrl);
    return true;
  }

  function finishImagePaste(paste: PendingImagePaste, outcome: ImagePasteOutcome): void {
    if (!markImagePasteFinished(paste)) return;
    notifyImagePaste(paste, outcome);
  }

  function abortInvalidImagePastes(session: EditorSession): void {
    for (const paste of imagePastes.values()) {
      if (paste.session === session && !paste.finished && !imagePasteIsCurrent(paste)) {
        paste.controller.abort();
        finishImagePaste(paste, { status: "stale" });
      }
    }
  }

  function imagePasteIsCurrent(paste: PendingImagePaste): boolean {
    return !disposed &&
      sessions.get(paste.session) === paste.data &&
      paste.data.revision === paste.revision &&
      !paste.data.readOnly;
  }

  function finishImagePasteError(paste: PendingImagePaste, error: unknown): void {
    if (paste.finished) return;
    if (!imagePasteIsCurrent(paste)) {
      finishImagePaste(paste, { status: "stale" });
      return;
    }
    finishImagePaste(paste, {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  function webpAssetMarkdown(result: EditorImageUploadResult): string {
    const prefix = "z-images/";
    const assetName = result.name.startsWith(prefix) ? result.name.slice(prefix.length) : "";
    if (
      assetName === "" ||
      assetName.includes("/") ||
      assetName.includes("\\") ||
      !assetName.endsWith(".webp") ||
      result.markdown.trim() === ""
    ) {
      throw new TypeError("Image upload returned an invalid WebP asset");
    }
    return result.markdown;
  }

  async function encodeImageAsWebp(file: File): Promise<Blob> {
    if (file.type === "image/webp") return file;
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("Could not create an image conversion context");
      context.drawImage(bitmap, 0, 0);
      const image = await canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
      if (image.type !== "image/webp") throw new Error("Browser did not convert the pasted image to WebP");
      return image;
    } finally {
      bitmap.close();
    }
  }

  function insertPastedImage(paste: PendingImagePaste, markdown: string): void {
    const from = Math.min(paste.selection.anchor, paste.selection.head);
    const to = Math.max(paste.selection.anchor, paste.selection.head);
    const transaction = {
      changes: { from, to, insert: markdown },
      selection: { anchor: from + markdown.length },
      annotations: [transactionOrigin.of("userEdit"), Transaction.userEvent.of("input.image-paste")],
    };

    if (!markImagePasteFinished(paste)) return;
    try {
      if (activeSession === paste.session) {
        view.dispatch(transaction);
      } else {
        const update = paste.data.state.update(transaction);
        paste.data.state = update.state;
        paste.data.revision++;
        paste.data.dirty = true;
        paste.data.sourceCacheRevision = -1;
        abortInvalidImagePastes(paste.session);
        config.onChange?.({ noteId: paste.session.noteId, revision: paste.data.revision, origin: "userEdit" });
      }
    } finally {
      notifyImagePaste(paste, { status: "inserted" });
    }
  }

  async function runImagePaste(
    paste: PendingImagePaste,
    upload: (request: EditorImageUploadRequest) => Promise<EditorImageUploadResult>,
  ): Promise<void> {
    try {
      let image: Blob;
      try {
        image = await encodeImageAsWebp(paste.file);
      } catch (error) {
        finishImagePasteError(paste, error);
        return;
      }
      if (paste.finished) return;
      if (!imagePasteIsCurrent(paste)) {
        finishImagePaste(paste, { status: "stale" });
        return;
      }
      let result: EditorImageUploadResult;
      try {
        result = await upload({
          image,
          noteId: paste.session.noteId,
          revision: paste.revision,
          selection: { ...paste.selection },
          signal: paste.controller.signal,
        });
      } catch (error) {
        finishImagePasteError(paste, error);
        return;
      }
      if (paste.finished) return;
      if (!imagePasteIsCurrent(paste)) {
        finishImagePaste(paste, { status: "stale" });
        return;
      }
      let markdown: string;
      try {
        markdown = webpAssetMarkdown(result);
      } catch (error) {
        finishImagePasteError(paste, error);
        return;
      }
      insertPastedImage(paste, markdown);
    } finally {
      imagePastes.delete(paste.uploadId);
    }
  }

  function beginImagePaste(view: EditorView, file: File): void {
    const session = activeSession;
    const upload = config.uploadPastedImage;
    if (session === null || upload === undefined || view.state.facet(readOnlyFacet)) return;
    const data = sessionData(session, owner);
    if (data.readOnly) return;
    const selection = view.state.selection.main;
    const uploadId = nextImagePasteId++;
    const revision = data.revision;
    const pasteSelection = { anchor: selection.anchor, head: selection.head };
    let previewUrl: string;
    try {
      previewUrl = URL.createObjectURL(file);
    } catch (error) {
      notifyImagePasteState({
        uploadId,
        noteId: session.noteId,
        revision,
        selection: pasteSelection,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const paste: PendingImagePaste = {
      uploadId,
      session,
      data,
      revision,
      selection: pasteSelection,
      file,
      previewUrl,
      controller: new AbortController(),
      task: null,
      finished: false,
    };
    imagePastes.set(paste.uploadId, paste);
    notifyImagePasteState({
      ...imagePasteContext(paste),
      status: "uploading",
      previewUrl: paste.previewUrl,
    });
    if (paste.finished) {
      imagePastes.delete(paste.uploadId);
      return;
    }
    paste.task = runImagePaste(paste, upload).catch((error: unknown) => {
      console.error(error);
    });
  }

  const updateListener = EditorView.updateListener.of((update) => {
    if (activeSession === null) return;
    const data = sessionData(activeSession, owner);
    data.state = update.state;
    data.scroll = { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft };
    scheduleActiveHeadingSync();
    const userTransactions = update.transactions.filter(
      (transaction) => transaction.docChanged && transaction.annotation(transactionOrigin) === "userEdit",
    );
    if (userTransactions.length === 0) return;
    data.revision += userTransactions.length;
    data.dirty = true;
    data.sourceCacheRevision = -1;
    const change: EditorChange = {
      noteId: activeSession.noteId,
      revision: data.revision,
      origin: "userEdit",
    };
    abortInvalidImagePastes(activeSession);
    config.onChange?.(change);
  });

  const pasteHandler = EditorView.domEventHandlers({
    paste(event, editorView) {
      const imageItem = config.uploadPastedImage === undefined || event.clipboardData === null
        ? undefined
        : [...event.clipboardData.items].find((item) => item.type.startsWith("image/"));
      if (imageItem !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        const file = imageItem.getAsFile();
        if (file !== null) beginImagePaste(editorView, file);
        return true;
      }
      const html = event.clipboardData?.getData("text/html");
      if (!html) return false;
      event.preventDefault();
      event.stopPropagation();
      if (editorView.state.facet(readOnlyFacet)) return true;
      const markdownSource = sanitizeHtmlToMarkdown(html);
      if (markdownSource === "") return true;
      const selection = editorView.state.selection.main;
      editorView.dispatch({
        changes: { from: selection.from, to: selection.to, insert: markdownSource },
        selection: { anchor: selection.from + markdownSource.length },
        annotations: [transactionOrigin.of("userEdit"), Transaction.userEvent.of("input.paste")],
      });
      return true;
    },
  });

  const clipboardHandler = EditorView.domEventHandlers({
    copy(event, editorView) {
      const selection = editorView.state.selection;
      const ranges = selection.ranges.filter((range) => !range.empty);
      if (ranges.length === 0 || event.clipboardData === null) return false;
      event.clipboardData.setData(
        "text/plain",
        ranges.map((range) => editorView.state.sliceDoc(range.from, range.to)).join(editorView.state.lineBreak),
      );
      event.preventDefault();
      return true;
    },
    cut(event, editorView) {
      const selection = editorView.state.selection;
      const ranges = selection.ranges.filter((range) => !range.empty);
      if (ranges.length === 0 || event.clipboardData === null) return false;
      event.clipboardData.setData(
        "text/plain",
        ranges.map((range) => editorView.state.sliceDoc(range.from, range.to)).join(editorView.state.lineBreak),
      );
      event.preventDefault();
      if (!editorView.state.facet(readOnlyFacet)) {
        editorView.dispatch({
          changes: ranges,
          annotations: [transactionOrigin.of("userEdit"), Transaction.userEvent.of("delete.cut")],
        });
      }
      return true;
    },
  });

  const initialState = createState(
    "",
    config.mode ?? "live",
    config.readOnly ?? false,
    config,
    modeCompartment,
    readOnlyCompartment,
    keymapCompartment,
    updateListener,
    clipboardHandler,
    pasteHandler,
  );
  const view = new EditorView({ state: initialState, parent: container });
  if (config.className) view.dom.classList.add(config.className);
  let activeHeadingFrom: number | null | undefined;
  let activeHeadingFrame: number | null = null;

  function syncActiveHeading(): void {
    const headings = activeSession === null ? [] : outlineFromSyntaxTree(view.state).headings;
    const scroller = view.scrollDOM;
    let active: OutlineHeading | null = null;
    if (headings.length > 0) {
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      if (atBottom) {
        active = headings[headings.length - 1] ?? null;
      } else {
        const threshold = scroller.scrollTop + Math.min(96, Math.max(24, scroller.clientHeight * 0.18));
        for (const heading of headings) {
          if (view.lineBlockAt(heading.from).top > threshold) break;
          active = heading;
        }
        active ??= headings[0] ?? null;
      }
    }
    const from = active?.from ?? null;
    if (activeHeadingFrom === from) return;
    activeHeadingFrom = from;
    config.onActiveHeadingChange?.(active);
  }

  function scheduleActiveHeadingSync(): void {
    if (activeHeadingFrame !== null) return;
    activeHeadingFrame = requestAnimationFrame(() => {
      activeHeadingFrame = null;
      syncActiveHeading();
    });
  }

  view.scrollDOM.addEventListener("scroll", scheduleActiveHeadingSync, { passive: true });

  function ensureActive(): SessionData | null {
    if (disposed) throw new TypeError("Editor has been disposed");
    return activeSession === null ? null : sessionData(activeSession, owner);
  }

  function storeActiveState(): void {
    if (activeSession === null) return;
    const data = sessionData(activeSession, owner);
    data.state = view.state;
    data.scroll = { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft };
  }

  function reconfigure(
    data: SessionData,
    origin: EditorOrigin,
    parts: { editorExtensions?: boolean; readOnly?: boolean; keymap?: boolean } = {},
  ): void {
    const effects: StateEffect<unknown>[] = [];
    if (parts.editorExtensions ?? true) {
      effects.push(modeCompartment.reconfigure(editorExtensions(config, data.mode === "live")));
    }
    if (parts.readOnly ?? true) effects.push(readOnlyCompartment.reconfigure(readOnlyExtension(data.readOnly)));
    if (parts.keymap ?? true) effects.push(keymapCompartment.reconfigure(editorKeymap(config)));
    if (effects.length === 0) return;
    view.dispatch({
      effects,
      annotations: transactionOrigin.of(origin),
    });
    data.state = view.state;
  }

  function currentSource(data: SessionData): string {
    if (data.sourceCacheRevision !== data.revision) {
      data.sourceCache = data.state.doc.toString();
      data.sourceCacheRevision = data.revision;
    }
    return data.sourceCache;
  }

  function sourceChange(data: SessionData, transform: (source: string, start: number, end: number) => FormatResult): void {
    if (data.readOnly) return;
    const selection = data.state.selection.main;
    const result = transform(currentSource(data), selection.from, selection.to);
    const current = currentSource(data);
    let prefix = 0;
    while (prefix < current.length && prefix < result.md.length && current[prefix] === result.md[prefix]) prefix++;
    let currentEnd = current.length;
    let nextEnd = result.md.length;
    while (currentEnd > prefix && nextEnd > prefix && current[currentEnd - 1] === result.md[nextEnd - 1]) {
      currentEnd--;
      nextEnd--;
    }
    if (currentEnd === prefix && nextEnd === prefix) return;
    view.dispatch({
      changes: { from: prefix, to: currentEnd, insert: result.md.slice(prefix, nextEnd) },
      selection: { anchor: result.selStart, head: result.selEnd },
      annotations: [transactionOrigin.of("userEdit"), Transaction.userEvent.of("input.format")],
    });
  }

  return {
    createSession(noteId, source, options = {}) {
      if (disposed) throw new TypeError("Editor has been disposed");
      if (noteId === "") throw new TypeError("Editor session noteId must not be empty");
      const mode = options.mode ?? config.mode ?? "live";
      const readOnly = options.readOnly ?? config.readOnly ?? false;
      const session = Object.freeze({ noteId }) as EditorSession;
      sessions.set(session, {
        owner,
        state: createState(
          source,
          mode,
          readOnly,
          config,
          modeCompartment,
          readOnlyCompartment,
          keymapCompartment,
          updateListener,
          clipboardHandler,
          pasteHandler,
        ),
        revision: 0,
        dirty: false,
        mode,
        readOnly,
        sourceCache: source,
        sourceCacheRevision: 0,
        scroll: { top: 0, left: 0 },
      });
      return session;
    },

    attachSession(session) {
      if (disposed) throw new TypeError("Editor has been disposed");
      const data = sessionData(session, owner);
      if (activeSession === session) return;
      storeActiveState();
      activeSession = session;
      view.setState(data.state);
      reconfigure(data, "modeChange");
      view.scrollDOM.scrollTop = data.scroll.top;
      view.scrollDOM.scrollLeft = data.scroll.left;
      scheduleActiveHeadingSync();
    },

    detachSession() {
      if (disposed) throw new TypeError("Editor has been disposed");
      storeActiveState();
      const detached = activeSession;
      activeSession = null;
      view.setState(initialState);
      scheduleActiveHeadingSync();
      return detached;
    },

    dispose() {
      if (disposed) return;
      storeActiveState();
      activeSession = null;
      disposed = true;
      for (const paste of imagePastes.values()) {
        paste.controller.abort();
        markImagePasteFinished(paste);
      }
      if (activeHeadingFrame !== null) cancelAnimationFrame(activeHeadingFrame);
      view.destroy();
    },

    focus() {
      if (ensureActive() !== null) view.focus();
    },

    getSnapshot() {
      const data = ensureActive();
      if (data === null || activeSession === null) return null;
      data.scroll = { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft };
      return {
        noteId: activeSession.noteId,
        source: currentSource(data),
        revision: data.revision,
        selection: { anchor: data.state.selection.main.anchor, head: data.state.selection.main.head },
        mode: data.mode,
        readOnly: data.readOnly,
        scroll: { ...data.scroll },
        dirty: data.dirty,
      };
    },

    markSaved(session, revision) {
      const data = sessionData(session, owner);
      if (data.revision !== revision) return false;
      data.dirty = false;
      return true;
    },

    reloadIfClean(session, source) {
      const data = sessionData(session, owner);
      if (data.dirty) return { kind: "dirty", revision: data.revision };
      if (currentSource(data) === source) return { kind: "unchanged", revision: data.revision };
      data.revision++;
      abortInvalidImagePastes(session);
      data.dirty = false;
      data.sourceCache = source;
      data.sourceCacheRevision = data.revision;
      data.scroll = { top: 0, left: 0 };
      data.state = createState(
        source,
        data.mode,
        data.readOnly,
        config,
        modeCompartment,
        readOnlyCompartment,
        keymapCompartment,
        updateListener,
        clipboardHandler,
        pasteHandler,
      );
      if (activeSession === session) {
        view.setState(data.state);
        view.scrollDOM.scrollTop = 0;
        view.scrollDOM.scrollLeft = 0;
        scheduleActiveHeadingSync();
      }
      return { kind: "reloaded", revision: data.revision };
    },

    setMode(mode) {
      const data = ensureActive();
      if (data === null) {
        config = { ...config, mode };
        return;
      }
      if (data.mode === mode) return;
      data.mode = mode;
      reconfigure(data, "modeChange", { editorExtensions: true, readOnly: false, keymap: false });
    },

    updateConfiguration(partial) {
      if (disposed) throw new TypeError("Editor has been disposed");
      const previous = config;
      config = { ...config, ...partial };
      const session = activeSession;
      const data = session === null ? null : sessionData(session, owner);
      if (data === null) return;
      const previousMode = data.mode;
      const previousReadOnly = data.readOnly;
      if (Object.hasOwn(partial, "readOnly")) data.readOnly = partial.readOnly ?? false;
      if (Object.hasOwn(partial, "mode")) data.mode = partial.mode ?? data.mode;
      if (session !== null && data.readOnly) abortInvalidImagePastes(session);
      const modeChanged = data.mode !== previousMode;
      const editorExtensionsChanged = modeChanged || (data.mode === "live" && !sameEditorExtensionInputs(previous, config));
      const readOnlyChanged = data.readOnly !== previousReadOnly;
      const keymapChanged = previous.onSave !== config.onSave || previous.onFindRequested !== config.onFindRequested;
      reconfigure(data, "modeChange", {
        editorExtensions: editorExtensionsChanged,
        readOnly: readOnlyChanged,
        keymap: keymapChanged,
      });
    },

    revealSelection(selection) {
      const data = ensureActive();
      if (data === null) return false;
      if (
        !Number.isInteger(selection.anchor) ||
        !Number.isInteger(selection.head) ||
        selection.anchor < 0 ||
        selection.head < 0 ||
        selection.anchor > data.state.doc.length ||
        selection.head > data.state.doc.length
      ) return false;
      view.dispatch({
        selection: EditorSelection.single(selection.anchor, selection.head),
        scrollIntoView: true,
      });
      return true;
    },

    find(query) {
      const data = ensureActive();
      return data === null ? [] : findLiteral(currentSource(data), query);
    },

    setFindHighlights(highlights) {
      if (ensureActive() === null) return;
      view.dispatch({
        effects: setFindHighlightsEffect.of(highlights),
      });
    },

    revealFindMatch(match) {
      const data = ensureActive();
      if (data === null || match.from < 0 || match.to > data.state.doc.length || match.from > match.to) return false;
      view.dispatch({
        effects: EditorView.scrollIntoView(match.from, { y: "nearest" }),
      });
      return true;
    },

    outline() {
      const data = ensureActive();
      return data === null ? { headings: [], complete: true } : outlineFromSyntaxTree(data.state);
    },

    formatSelection(command) {
      const data = ensureActive();
      if (data === null) return;
      const operation = command === "bold"
        ? toggleBold
        : command === "italic"
        ? toggleItalic
        : command === "highlight"
        ? toggleHighlight
        : command === "strikethrough"
        ? toggleStrikethrough
        : (source: string, start: number) => toggleHeading(source, start, 1);
      sourceChange(data, operation);
    },

    updateTags(tags) {
      const data = ensureActive();
      if (data === null || data.readOnly) return false;
      const edit = tagsSourceEdit(currentSource(data), tags);
      if (edit === null) return false;
      view.dispatch({
        changes: edit,
        annotations: [transactionOrigin.of("userEdit"), Transaction.userEvent.of("input.tags")],
      });
      return true;
    },

    undo() {
      const data = ensureActive();
      return data !== null && !data.readOnly && undo(view);
    },

    redo() {
      const data = ensureActive();
      return data !== null && !data.readOnly && redo(view);
    },
  };
}
