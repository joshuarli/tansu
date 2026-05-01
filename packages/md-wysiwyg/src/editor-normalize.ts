const NORMALIZABLE_BLOCK_SELECTOR = "h1, h2, h3, h4, h5, h6, p, div, li";

function isMarkerNode(node: Node): boolean {
  if (!(node instanceof HTMLElement)) {
    return false;
  }
  return (
    node.dataset["mdCursor"] === "true" ||
    node.dataset["mdSelStart"] === "true" ||
    node.dataset["mdSelEnd"] === "true" ||
    Object.hasOwn(node.dataset, "blockCursor")
  );
}

function hasSubstantiveContent(block: HTMLElement): boolean {
  for (const child of block.childNodes) {
    if (child instanceof HTMLBRElement || isMarkerNode(child)) {
      continue;
    }
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent ?? "").replaceAll("​", "").trim() !== "") {
        return true;
      }
      continue;
    }
    if (
      child instanceof HTMLElement &&
      (child.tagName === "INPUT" || child.tagName === "UL" || child.tagName === "OL")
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function trimLeadingPlaceholderBreaks(block: HTMLElement): void {
  let current = block.firstChild;
  while (current && isMarkerNode(current)) {
    current = current.nextSibling;
  }
  while (current instanceof HTMLBRElement) {
    const next = current.nextSibling;
    current.remove();
    current = next;
    while (current && isMarkerNode(current)) {
      current = current.nextSibling;
    }
  }
}

function trimTrailingPlaceholderBreaks(block: HTMLElement): void {
  let current = block.lastChild;
  while (current && isMarkerNode(current)) {
    current = current.previousSibling;
  }
  while (current instanceof HTMLBRElement) {
    const previous = current.previousSibling;
    current.remove();
    current = previous;
    while (current && isMarkerNode(current)) {
      current = current.previousSibling;
    }
  }
}

function normalizeEditableBlock(block: HTMLElement): void {
  if (block.dataset["mdBlank"] === "true" || !hasSubstantiveContent(block)) {
    return;
  }
  trimLeadingPlaceholderBreaks(block);
  trimTrailingPlaceholderBreaks(block);
}

export function normalizeEditableContent(root: ParentNode): void {
  if (root instanceof HTMLElement && root.matches(NORMALIZABLE_BLOCK_SELECTOR)) {
    normalizeEditableBlock(root);
  }
  for (const block of root.querySelectorAll(NORMALIZABLE_BLOCK_SELECTOR)) {
    if (block instanceof HTMLElement) {
      normalizeEditableBlock(block);
    }
  }
}
