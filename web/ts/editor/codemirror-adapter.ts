import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { indentWithTab, defaultKeymap, history, historyKeymap, redo, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { codeFolding, foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";
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
  WidgetType,
} from "@codemirror/view";
import { atomicEditorTheme, atomicMarkdownSyntax } from "./vendor/atomic/atomic-theme.js";
import { autoCloseCodeFence, extendEmphasisPair, startAsteriskList } from "./vendor/atomic/edit-helpers.js";
import { highlightMarkdown } from "./vendor/atomic/highlight.js";
import { imageBlocks } from "./vendor/atomic/image-blocks.js";
import { inlinePreview } from "./vendor/atomic/inline-preview.js";
import { readOnlyExtension, readOnlyFacet } from "./vendor/atomic/read-only.js";
import { tables } from "./vendor/atomic/table-widget.js";
import { wikiLinks } from "./vendor/atomic/wiki-links.js";
import { blockDragHandles } from "./block-drag.js";
import { calloutDecoration } from "./callout-decoration.js";
import { slashMenu } from "./slash-menu.js";
import { urlCards } from "./url-card.js";
import { frontmatterRange, type FrontmatterRange } from "./frontmatter.js";
import { sanitizeHtmlToMarkdown } from "./clipboard.js";
import { findLiteral, outlineFromSyntaxTree, type FindMatch, type Outline, type OutlineHeading } from "./source-navigation.js";
import { convertImageToWebp, webpAssetMarkdown } from "./image-webp.js";
import { tufteNotes } from "./tufte-notes.js";
import { addPendingImagePreview, pendingImagePreviews, removePendingImagePreview } from "./pasted-image-preview.js";
import {
  type EditorChange,
  type EditorConfig,
  type EditorImagePasteSelection,
  type EditorImagePasteState,
  type EditorImageUploadRequest,
  type EditorImageUploadResult,
} from "./tansu-extensions.js";
import { resolveWikiTarget, suggestWikiTargets, type WikiNote } from "./wiki-target.js";
import { wikiImages } from "./wiki-images.js";
import { wikiPreviewCards } from "./wiki-preview.js";
import {
  toggleBold,
  toggleHeading,
  toggleHighlight,
  toggleItalic,
  toggleStrikethrough,
  type FormatResult,
} from "./format-ops.js";

const transactionOrigin = Annotation.define<EditorOrigin>();
const EMPTY_CALLOUT_ICONS: Readonly<Record<string, string>> = {};

const frontmatterLineDecorations = StateField.define<DecorationSet>({
  create: frontmatterLineDecorationSet,
  update(decorations, transaction) {
    return transaction.docChanged ? frontmatterLineDecorationSet(transaction.state) : decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function frontmatterLineDecorationSet(state: EditorState): DecorationSet {
  const frontmatter = frontmatterRange(state);
  return frontmatter === null
    ? Decoration.none
    : Decoration.set([Decoration.line({ class: "cm-frontmatter-line" }).range(frontmatter.from)]);
}

class NoteHeaderWidget extends WidgetType {
  constructor(
    readonly title: string,
    readonly onTitleCommit: EditorConfig["onNoteTitleCommit"],
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof NoteHeaderWidget && this.title === other.title &&
      this.onTitleCommit === other.onTitleCommit;
  }

  override toDOM(): HTMLElement {
    const header = document.createElement("div");
    header.className = "note-header";
    header.contentEditable = "false";
    const title = document.createElement("h1");
    title.className = this.onTitleCommit === undefined ? "document-title" : "document-title is-editable";
    title.textContent = this.title;
    const onTitleCommit = this.onTitleCommit;
    if (onTitleCommit !== undefined) {
      let titleAtFocus = this.title;
      let canceled = false;
      title.contentEditable = "true";
      title.setAttribute("aria-label", "Note name");
      title.title = "Click to edit note name";
      title.addEventListener("focus", () => {
        titleAtFocus = title.textContent ?? this.title;
        canceled = false;
      });
      title.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submitOnEnter = true;
          title.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          canceled = true;
          title.textContent = titleAtFocus;
          title.blur();
        }
      });
      let submitOnEnter = false;
      title.addEventListener("blur", () => {
        const nextTitle = title.textContent?.trim() ?? "";
        const submit = submitOnEnter;
        submitOnEnter = false;
        if (canceled || nextTitle === titleAtFocus) {
          canceled = false;
          return;
        }
        title.contentEditable = "false";
        void onTitleCommit({ title: nextTitle, intent: submit ? "submit" : "rename" }).then((accepted) => {
          if (!accepted && title.isConnected) title.textContent = this.title;
          if (title.isConnected) title.contentEditable = "true";
        }, () => {
          if (title.isConnected) {
            title.textContent = this.title;
            title.contentEditable = "true";
          }
        });
      });
    }
    header.append(title);
    return header;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function selectionTouchesFrontmatter(selection: EditorSelection, range: FrontmatterRange): boolean {
  return selection.ranges.some((selected) => selected.empty
    ? selected.head >= range.from && selected.head < range.to
    : selected.from < range.to && selected.to > range.from);
}

function foldFrontmatterState(state: EditorState): EditorState {
  const range = frontmatterRange(state);
  if (range === null) return state;
  return state.update({
    selection: EditorSelection.cursor(range.to),
    effects: foldEffect.of({ from: range.from, to: range.foldTo }),
  }).state;
}

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
  getSessionSnapshot(session: EditorSession): EditorSnapshot;
  markSaved(session: EditorSession, revision: number): boolean;
  reloadIfClean(session: EditorSession, source: string): ReloadResult;
  setMode(mode: EditorMode): void;
  updateConfiguration(partial: Partial<EditorConfig>): void;
  revealSelection(selection: EditorSelectionSnapshot): boolean;
  revealOutlineHeading(heading: OutlineHeading): boolean;
  scrollByWheel(delta: Pick<WheelEvent, "deltaY" | "deltaMode">): boolean;
  find(query: string): readonly FindMatch[];
  setFindHighlights(highlights: { matches: readonly FindMatch[]; selected: FindMatch | null }): void;
  revealFindMatch(match: FindMatch): boolean;
  outline(): Outline;
  formatSelection(command: FormatCommand): void;
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
  if ((config.noteTitle !== undefined && config.noteTitle !== "") || config.onNoteTitleCommit !== undefined) {
    const decoration = Decoration.widget({
      widget: new NoteHeaderWidget(
        config.noteTitle ?? "",
        config.onNoteTitleCommit,
      ),
      side: -1,
      block: true,
    }).range(0);
    extensions.push(StateField.define<DecorationSet>({
      create: () => Decoration.set([decoration]),
      update(decorations, transaction) {
        return transaction.docChanged ? decorations.map(transaction.changes) : decorations;
      },
      provide: (field) => EditorView.decorations.from(field),
    }));
  }
  if (!live) return extensions;

  const resolveAssetUrl = config.resolveAssetUrl;
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

  if (resolveAssetUrl !== undefined) extensions.push(wikiImages({ resolveUrl: resolveAssetUrl }));
  extensions.push(
    inlinePreview(config.onLinkOpen ? { onLinkClick: config.onLinkOpen } : {}),
    imageBlocks((source) => resolveMarkdownImageUrl(source, resolveAssetUrl)),
    tables(config.onLinkOpen ? { onLinkClick: config.onLinkOpen } : {}),
    calloutDecoration({ icons: config.calloutIcons ?? EMPTY_CALLOUT_ICONS }),
    tufteNotes(),
    slashMenu(),
    blockDragHandles(),
    urlCards(config.onLinkOpen ? { onOpen: config.onLinkOpen } : {}),
  );
  if (hasWikiLinks(config)) {
    extensions.push(wikiLinks(wikiConfig));
    const loadNotePreview = config.loadNotePreview;
    if (loadNotePreview !== undefined) {
      extensions.push(wikiPreviewCards({
        resolve: (target) => {
          const result = resolveWikiTarget(target, config.currentNotePath?.() ?? "", config.wikiNotes?.() ?? []);
          return result.kind === "resolved" ? result.note : null;
        },
        load: loadNotePreview,
      }));
    }
  }
  return extensions;
}

type WikiScope = { currentNotePath: string; notes: readonly WikiNote[] };

function hasWikiLinks(config: EditorConfig): boolean {
  return config.wikiLinks === true;
}

function wikiScope(config: EditorConfig): WikiScope {
  return { currentNotePath: config.currentNotePath?.() ?? "", notes: config.wikiNotes?.() ?? [] };
}

function sameWikiScope(left: WikiScope, right: WikiScope): boolean {
  return left.currentNotePath === right.currentNotePath && left.notes.length === right.notes.length &&
    left.notes.every((note, index) => {
      const other = right.notes[index]!;
      return note.noteId === other.noteId && note.path === other.path && note.title === other.title;
    });
}

function sameRecord(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) =>
    Object.hasOwn(right, key) && left[key] === right[key]
  );
}

function sameLiveFeatureInputs(left: EditorConfig, right: EditorConfig): boolean {
  const leftWikiLinks = hasWikiLinks(left);
  const rightWikiLinks = hasWikiLinks(right);
  return leftWikiLinks === rightWikiLinks && left.onLinkOpen === right.onLinkOpen &&
    left.resolveAssetUrl === right.resolveAssetUrl &&
    sameRecord(left.calloutIcons ?? EMPTY_CALLOUT_ICONS, right.calloutIcons ?? EMPTY_CALLOUT_ICONS) &&
    (!leftWikiLinks || (
      left.currentNotePath === right.currentNotePath &&
      left.wikiNotes === right.wikiNotes &&
      left.onWikiNoteOpen === right.onWikiNoteOpen &&
      left.loadNotePreview === right.loadNotePreview
    ));
}

function historyExtension(config: EditorConfig): Extension {
  return config.undoStackMax === undefined ? history() : history({ minDepth: config.undoStackMax });
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
  historyCompartment: Compartment,
  updateListener: Extension,
  clipboardHandler: Extension,
  pasteHandler: Extension,
): EditorState {
  return EditorState.create({
    doc: source,
    extensions: [
      historyCompartment.of(historyExtension(config)),
      codeFolding({ placeholderText: "" }),
      frontmatterLineDecorations,
      EditorView.atomicRanges.of((view) => foldedRanges(view.state)),
      findHighlightField,
      pendingImagePreviews,
      markdown({ base: markdownLanguage, codeLanguages: [], extensions: [highlightMarkdown] }),
      atomicEditorTheme,
      atomicMarkdownSyntax,
      EditorState.allowMultipleSelections.of(true),
      EditorState.transactionFilter.of((transaction) => {
        if (!transaction.docChanged) return transaction;
        const origin = transaction.annotation(transactionOrigin);
        if (origin === "load" || origin === "externalReload") return transaction;
        if (transaction.startState.facet(readOnlyFacet)) return [];
        const frontmatter = frontmatterRange(transaction.startState);
        const nextFrontmatter = frontmatterRange(transaction.newDoc);
        if (frontmatter === null) return nextFrontmatter === null ? transaction : [];
        if (frontmatter.kind === "unterminated" && nextFrontmatter !== null) return [];
        let touchesFrontmatter = false;
        transaction.changes.iterChangedRanges((from, to) => {
          touchesFrontmatter ||= from === to
            ? from >= frontmatter.from && (from < frontmatter.to || (frontmatter.kind === "unterminated" && from === frontmatter.to))
            : from < frontmatter.to && to > frontmatter.from;
        });
        return touchesFrontmatter ? [] : transaction;
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
  let appliedWikiScope: WikiScope | null = null;
  let disposed = false;
  const owner = Symbol("editor");
  const modeCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();
  const keymapCompartment = new Compartment();
  const historyCompartment = new Compartment();
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

  function removeImagePastePreview(paste: PendingImagePaste): void {
    queueMicrotask(() => {
      if (disposed) return;
      const transaction = { effects: removePendingImagePreview.of(paste.uploadId) };
      if (activeSession === paste.session) view.dispatch(transaction);
      else paste.data.state = paste.data.state.update(transaction).state;
    });
  }

  function markImagePasteFinished(paste: PendingImagePaste): boolean {
    if (paste.finished) return false;
    paste.finished = true;
    URL.revokeObjectURL(paste.previewUrl);
    return true;
  }

  function finishImagePaste(paste: PendingImagePaste, outcome: ImagePasteOutcome): void {
    if (!markImagePasteFinished(paste)) return;
    removeImagePastePreview(paste);
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

  async function encodeImageAsWebp(file: File): Promise<Blob> {
    if (file.type === "image/webp") return file;
    const quality = config.imageWebpQuality;
    if (quality === undefined) throw new TypeError("Converting a pasted image requires imageWebpQuality");
    return convertImageToWebp(file, quality);
  }

  function insertPastedImage(paste: PendingImagePaste, markdown: string): void {
    const from = Math.min(paste.selection.anchor, paste.selection.head);
    const to = Math.max(paste.selection.anchor, paste.selection.head);
    const transaction = {
      changes: { from, to, insert: markdown },
      selection: { anchor: from + markdown.length },
      effects: removePendingImagePreview.of(paste.uploadId),
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
    view.dispatch({
      effects: addPendingImagePreview.of({
        uploadId: paste.uploadId,
        position: paste.selection.head,
        src: paste.previewUrl,
      }),
    });
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

  let scheduleSelectionToolbarSyncAction: (() => void) | null = null;
  const scheduleSelectionToolbarSync = () => scheduleSelectionToolbarSyncAction?.();
  const updateListener = EditorView.updateListener.of((update) => {
    scheduleSelectionToolbarSync();
    if (activeSession === null) return;
    const data = sessionData(activeSession, owner);
    data.state = update.state;
    data.scroll = { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft };
    if (update.docChanged) updateFrontmatterFold(data);
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
    historyCompartment,
    updateListener,
    clipboardHandler,
    pasteHandler,
  );
  const view = new EditorView({ state: initialState, parent: container });
  if (config.className) view.dom.classList.add(config.className);
  let activeHeadingFrom: number | null | undefined;
  let activeHeadingFrame: number | null = null;
  let selectionToolbarFrame: number | null = null;

  function updateFrontmatterFold(data: SessionData): void {
    const state = view.state;
    const range = frontmatterRange(state);
    const folds: { from: number; to: number }[] = [];
    foldedRanges(state).between(0, state.doc.length, (from, to) => {
      if (from === 0) folds.push({ from, to });
    });
    const currentFold = folds[0] ?? null;
    const shouldFold = range !== null;
    const alreadyFolded = shouldFold && range !== null && currentFold?.to === range.foldTo;
    if (alreadyFolded || (!shouldFold && currentFold === null)) return;

    const effects: StateEffect<unknown>[] = [];
    if (currentFold !== null) effects.push(unfoldEffect.of(currentFold));
    if (shouldFold && range !== null) effects.push(foldEffect.of({ from: range.from, to: range.foldTo }));
    const selectionTouches = shouldFold && range !== null &&
      selectionTouchesFrontmatter(view.state.selection, range);
    view.dispatch({
      effects,
      ...(selectionTouches && range !== null ? { selection: EditorSelection.cursor(range.to) } : {}),
    });
    data.state = view.state;
  };

  function syncActiveHeading(): void {
    const headings = activeSession === null ? [] : outlineFromSyntaxTree(view.state).headings;
    const scroller = view.scrollDOM;
    let active: OutlineHeading | null = null;
    if (headings.length > 0) {
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      if (atBottom) {
        active = headings[headings.length - 1] ?? null;
      } else {
        const threshold = scroller.scrollTop + activeHeadingOffset(scroller);
        let low = 0;
        let high = headings.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (view.lineBlockAt(headings[middle]!.from).top > threshold) high = middle;
          else low = middle + 1;
        }
        active = headings[Math.max(low - 1, 0)] ?? null;
      }
    }
    const from = active?.from ?? null;
    if (activeHeadingFrom === from) return;
    activeHeadingFrom = from;
    config.onActiveHeadingChange?.(active);
  }

  function activeHeadingOffset(scroller: HTMLElement): number {
    return Math.min(96, Math.max(24, scroller.clientHeight * 0.18));
  }

  function syncScrollFade(): void {
    const scroller = view.scrollDOM;
    scroller.classList.toggle("has-more-above", scroller.scrollTop > 1);
  }

  function scheduleActiveHeadingSync(): void {
    if (activeHeadingFrame !== null) return;
    activeHeadingFrame = requestAnimationFrame(() => {
      activeHeadingFrame = null;
      syncScrollFade();
      syncActiveHeading();
    });
  }

  view.scrollDOM.addEventListener("scroll", scheduleActiveHeadingSync, { passive: true });
  window.addEventListener("resize", scheduleActiveHeadingSync, { passive: true });
  scheduleActiveHeadingSync();

  function ensureActive(): SessionData | null {
    if (disposed) throw new TypeError("Editor has been disposed");
    return activeSession === null ? null : sessionData(activeSession, owner);
  }

  function snapshotOf(session: EditorSession): EditorSnapshot {
    const data = sessionData(session, owner);
    if (activeSession === session) {
      data.scroll = { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft };
    }
    return {
      noteId: session.noteId,
      source: currentSource(data),
      revision: data.revision,
      selection: { anchor: data.state.selection.main.anchor, head: data.state.selection.main.head },
      mode: data.mode,
      readOnly: data.readOnly,
      scroll: { ...data.scroll },
      dirty: data.dirty,
    };
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
    parts: { editorExtensions?: boolean; readOnly?: boolean; keymap?: boolean; history?: boolean } = {},
  ): void {
    const effects: StateEffect<unknown>[] = [];
    if (parts.editorExtensions ?? true) {
      effects.push(modeCompartment.reconfigure(editorExtensions(config, data.mode === "live")));
      appliedWikiScope = hasWikiLinks(config) ? wikiScope(config) : null;
    }
    if (parts.readOnly ?? true) effects.push(readOnlyCompartment.reconfigure(readOnlyExtension(data.readOnly)));
    if (parts.keymap ?? true) effects.push(keymapCompartment.reconfigure(editorKeymap(config)));
    if (parts.history ?? true) effects.push(historyCompartment.reconfigure(historyExtension(config)));
    if (effects.length === 0) return;
    view.dispatch({
      effects,
      annotations: transactionOrigin.of(origin),
    });
    data.state = view.state;
    updateFrontmatterFold(data);
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

  function formatSelection(command: FormatCommand): void {
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
  }

  const selectionToolbar = document.createElement("div");
  selectionToolbar.className = "selection-toolbar";
  selectionToolbar.setAttribute("role", "toolbar");
  selectionToolbar.setAttribute("aria-label", "Text formatting");
  const formatButtons = [
    ["B", "Bold", "bold"],
    ["I", "Italic", "italic"],
    ["H", "Heading", "heading"],
    ["S̶", "Strikethrough", "strikethrough"],
    ["▰", "Highlight", "highlight"],
  ] as const;
  for (const [label, title, command] of formatButtons) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `selection-toolbar-button selection-toolbar-${command}`;
    button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      formatSelection(command);
    });
    selectionToolbar.append(button);
  }
  view.dom.append(selectionToolbar);

  let selectionPointerDown = false;

  function syncSelectionToolbar(): void {
    const selection = view.state.selection.main;
    if (activeSession === null || sessionData(activeSession, owner).readOnly || selection.empty ||
      selectionPointerDown || (!view.hasFocus && !selectionToolbar.contains(document.activeElement))) {
      selectionToolbar.classList.remove("is-visible");
      return;
    }
    const cursor = view.coordsAtPos(selection.head);
    if (cursor === null) {
      selectionToolbar.classList.remove("is-visible");
      return;
    }
    selectionToolbar.classList.add("is-visible");
    const { width, height } = selectionToolbar.getBoundingClientRect();
    const center = cursor.left + (cursor.right - cursor.left) / 2;
    const left = Math.max(width / 2 + 8, Math.min(window.innerWidth - width / 2 - 8, center));
    selectionToolbar.style.left = `${left}px`;
    selectionToolbar.style.top = `${Math.max(8, cursor.top - height - 8)}px`;
  }

  function scheduleToolbarSync(): void {
    if (selectionToolbarFrame !== null) return;
    selectionToolbarFrame = requestAnimationFrame(() => {
      selectionToolbarFrame = null;
      syncSelectionToolbar();
    });
  }

  function onEditorPointerDown(event: PointerEvent): void {
    if (event.target instanceof Node && selectionToolbar.contains(event.target)) return;
    selectionPointerDown = true;
    selectionToolbar.classList.remove("is-visible");
  }

  function onPointerUp(): void {
    if (!selectionPointerDown) return;
    selectionPointerDown = false;
    scheduleToolbarSync();
  }

  scheduleSelectionToolbarSyncAction = scheduleToolbarSync;
  view.dom.addEventListener("pointerdown", onEditorPointerDown);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("resize", scheduleToolbarSync, { passive: true });
  window.addEventListener("scroll", scheduleToolbarSync, { passive: true });
  view.scrollDOM.addEventListener("scroll", scheduleToolbarSync, { passive: true });
  scheduleToolbarSync();

  return {
    createSession(noteId, source, options = {}) {
      if (disposed) throw new TypeError("Editor has been disposed");
      if (noteId === "") throw new TypeError("Editor session noteId must not be empty");
      const mode = options.mode ?? config.mode ?? "live";
      const readOnly = options.readOnly ?? config.readOnly ?? false;
      const session = Object.freeze({ noteId }) as EditorSession;
      const state = foldFrontmatterState(createState(
        source,
        mode,
        readOnly,
        config,
        modeCompartment,
        readOnlyCompartment,
        keymapCompartment,
        historyCompartment,
        updateListener,
        clipboardHandler,
        pasteHandler,
      ));
      sessions.set(session, {
        owner,
        state,
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
      scheduleToolbarSync();
    },

    detachSession() {
      if (disposed) throw new TypeError("Editor has been disposed");
      storeActiveState();
      const detached = activeSession;
      activeSession = null;
      view.setState(initialState);
      scheduleActiveHeadingSync();
      scheduleToolbarSync();
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
      if (selectionToolbarFrame !== null) cancelAnimationFrame(selectionToolbarFrame);
      view.dom.removeEventListener("pointerdown", onEditorPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("resize", scheduleToolbarSync);
      window.removeEventListener("resize", scheduleActiveHeadingSync);
      window.removeEventListener("scroll", scheduleToolbarSync);
      view.scrollDOM.removeEventListener("scroll", scheduleActiveHeadingSync);
      view.scrollDOM.removeEventListener("scroll", scheduleToolbarSync);
      selectionToolbar.remove();
      view.destroy();
    },

    focus() {
      if (ensureActive() !== null) view.focus();
    },

    getSnapshot() {
      if (disposed) throw new TypeError("Editor has been disposed");
      return activeSession === null ? null : snapshotOf(activeSession);
    },

    getSessionSnapshot(session) {
      if (disposed) throw new TypeError("Editor has been disposed");
      return snapshotOf(session);
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
        historyCompartment,
        updateListener,
        clipboardHandler,
        pasteHandler,
      );
      data.state = foldFrontmatterState(data.state);
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
      reconfigure(data, "modeChange", { editorExtensions: true, readOnly: false, keymap: false, history: false });
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
      const wikiScopeChanged = data.mode === "live" && hasWikiLinks(config) &&
        (appliedWikiScope === null || !sameWikiScope(appliedWikiScope, wikiScope(config)));
      const editorExtensionsChanged = modeChanged || previous.noteTitle !== config.noteTitle || wikiScopeChanged ||
        (data.mode === "live" && !sameLiveFeatureInputs(previous, config));
      const readOnlyChanged = data.readOnly !== previousReadOnly;
      const keymapChanged = previous.onSave !== config.onSave || previous.onFindRequested !== config.onFindRequested;
      reconfigure(data, "modeChange", {
        editorExtensions: editorExtensionsChanged,
        readOnly: readOnlyChanged,
        keymap: keymapChanged,
        history: previous.undoStackMax !== config.undoStackMax,
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
      const frontmatter = frontmatterRange(data.state);
      const hiddenFrontmatterSelection = frontmatter !== null &&
        selectionTouchesFrontmatter(EditorSelection.single(selection.anchor, selection.head), frontmatter);
      const target = hiddenFrontmatterSelection
        ? { anchor: frontmatter.to, head: frontmatter.to }
        : selection;
      view.dispatch({
        selection: EditorSelection.single(target.anchor, target.head),
        scrollIntoView: true,
      });
      return true;
    },

    revealOutlineHeading(heading) {
      const data = ensureActive();
      if (
        data === null ||
        !Number.isInteger(heading.from) ||
        heading.from < 0 ||
        heading.from > data.state.doc.length
      ) return false;
      view.dispatch({
        selection: EditorSelection.single(heading.from),
        effects: EditorView.scrollIntoView(heading.from, {
          y: "start",
          yMargin: activeHeadingOffset(view.scrollDOM) + 1,
        }),
      });
      return true;
    },

    scrollByWheel({ deltaY, deltaMode }) {
      if (ensureActive() === null || !Number.isFinite(deltaY) || deltaY === 0) return false;
      const scroller = view.scrollDOM;
      const pixels = deltaMode === WheelEvent.DOM_DELTA_LINE
        ? deltaY * view.defaultLineHeight
        : deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? deltaY * scroller.clientHeight
        : deltaY;
      const previous = scroller.scrollTop;
      scroller.scrollTop += pixels;
      return scroller.scrollTop !== previous;
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

    formatSelection,

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
