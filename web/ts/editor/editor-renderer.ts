import type { EditorBlock, EditorDoc } from "./editor-model.js";
import type { MarkdownExtension } from "./extension.js";
import { renderEditorMarkdown } from "./markdown.js";

export type DomMap = {
  lineToElement: Map<string, HTMLElement>;
  blockToElement: Map<string, HTMLElement>;
};

type EditorRenderer = {
  render(md: string): void;
  renderFragment(md: string): HTMLElement[];
};

export function annotateEditorDom(root: HTMLElement, doc: EditorDoc): DomMap {
  const lineToElement = new Map<string, HTMLElement>();
  const blockToElement = new Map<string, HTMLElement>();
  const children = [...root.children].filter(
    (child): child is HTMLElement => child instanceof HTMLElement,
  );
  let childIndex = 0;

  for (const block of doc.blocks.blocks) {
    const lineCount = block.endLine - block.startLine;
    const oneElementPerLine = block.kind === "paragraph" || block.kind === "blank";
    const consumed = oneElementPerLine ? lineCount : 1;
    const blockElements = children.slice(childIndex, childIndex + consumed);
    childIndex += consumed;
    if (blockElements.length === 0) {
      continue;
    }

    for (const el of blockElements) {
      annotateBlockElement(el, block);
    }
    blockToElement.set(block.id, blockElements[0]!);
    ensureBlockHandle(blockElements[0]!, block.id);

    if (oneElementPerLine) {
      for (let line = block.startLine; line < block.endLine; line++) {
        const el = blockElements[line - block.startLine];
        if (el) {
          annotateLineElement(el, doc, line);
          lineToElement.set(doc.lines[line]!.id, el);
        }
      }
      continue;
    }

    const lineHosts = findLineHosts(blockElements[0]!, block);
    for (let line = block.startLine; line < block.endLine; line++) {
      const host = lineHosts[line - block.startLine] ?? blockElements[0]!;
      annotateLineElement(host, doc, line);
      lineToElement.set(doc.lines[line]!.id, host);
    }
  }

  return { lineToElement, blockToElement };
}

function annotateBlockElement(el: HTMLElement, block: EditorBlock): void {
  el.dataset["mdBlockId"] = block.id;
  el.dataset["mdBlockKind"] = block.kind;
}

function annotateLineElement(el: HTMLElement, doc: EditorDoc, line: number): void {
  el.dataset["mdLineId"] = doc.lines[line]!.id;
  el.dataset["mdLineIndex"] = String(line);
  const blockRef = doc.blocks.byLine[line];
  if (blockRef?.role === "blank") {
    el.dataset["mdBlankRole"] = blockRef.blankRole ?? "editable";
  } else {
    delete el.dataset["mdBlankRole"];
  }
  const text = doc.lines[line]!.text;
  const listMatch = text.match(/^([ \t]*([-*+]|\d+\.)(?: \[[ xX]\])?\s)(.*)$/);
  const headingMatch = text.match(/^(#{1,6}\s+)(.*)$/);
  const taskMatch = text.match(/^([ \t]*\[[ xX]\]\s+)(.*)$/);
  const quoteMatch = text.match(/^(>\s?)(.*)$/);
  const contentStart =
    listMatch?.[1]?.length ??
    headingMatch?.[1]?.length ??
    taskMatch?.[1]?.length ??
    quoteMatch?.[1]?.length;
  if (contentStart !== undefined) {
    el.dataset["mdLineContentStart"] = String(contentStart);
  } else {
    delete el.dataset["mdLineContentStart"];
  }
}

function ensureBlockHandle(el: HTMLElement, blockId: string): void {
  const host = blockHandleHost(el);
  if (host === null) return;
  const handles = [...host.querySelectorAll<HTMLButtonElement>(":scope > .md-block-handle")];
  let handle = handles[0];
  if (handle === undefined) {
    handle = document.createElement("button");
    handle.type = "button";
    handle.className = "md-block-handle";
    handle.contentEditable = "false";
    handle.tabIndex = 0;
    handle.ariaLabel = "Select block";
    host.append(handle);
  }
  for (const duplicate of handles.slice(1)) {
    duplicate.remove();
  }
  handle.dataset["mdBlockHandle"] = blockId;
}

function blockHandleHost(el: HTMLElement): HTMLElement | null {
  if (el instanceof HTMLUListElement || el instanceof HTMLOListElement) {
    return el.querySelector<HTMLElement>(":scope > li");
  }
  if (el instanceof HTMLTableElement) {
    const existingCaption = el.querySelector<HTMLElement>(":scope > caption");
    if (existingCaption !== null) return existingCaption;
    const caption = document.createElement("caption");
    caption.className = "md-block-handle-caption";
    el.prepend(caption);
    return caption;
  }
  return el;
}

function findLineHosts(el: HTMLElement, block: EditorBlock): HTMLElement[] {
  if (block.kind === "list") {
    return Array.from<Element, HTMLElement | null>(el.querySelectorAll("li"), (child) =>
      child instanceof HTMLElement ? child : null,
    ).filter((child): child is HTMLElement => child !== null);
  }
  if (block.kind === "code") {
    const code = el.querySelector("code");
    return code instanceof HTMLElement ? [code] : [el];
  }
  if (block.kind === "table") {
    return Array.from<Element, HTMLElement | null>(el.querySelectorAll("tr"), (child) =>
      child instanceof HTMLElement ? child : null,
    ).filter((child): child is HTMLElement => child !== null);
  }
  if (block.kind === "blockquote") {
    const children = [...el.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );
    return children.length > 0 ? children : [el];
  }
  return [el];
}

export function createEditorRenderer(
  contentEl: HTMLElement,
  extensions: readonly MarkdownExtension[],
  resolveImageUrl?: (src: string) => string,
): EditorRenderer {
  const renderOpts = {
    extensions: [...extensions],
    ...(resolveImageUrl === undefined ? {} : { resolveImageUrl }),
  };

  return {
    render(md) {
      contentEl.innerHTML = renderEditorMarkdown(md, renderOpts);
    },
    renderFragment(md) {
      const fragmentHost = contentEl.ownerDocument.createElement("div");
      fragmentHost.innerHTML = renderEditorMarkdown(md, renderOpts);
      return [...fragmentHost.children].filter(
        (child): child is HTMLElement => child instanceof HTMLElement,
      );
    },
  };
}
