export {
  renderMarkdown,
  renderMarkdownWithCursor,
  renderMarkdownWithSelection,
} from "./markdown.js";
export type { MarkdownExtension, BlockKind } from "./extension.js";
export { createWikiLinkExtension } from "./wiki-link.js";
export { createWikiImageExtension } from "./wiki-image.js";
export { createCalloutExtension } from "./callout.js";
export { highlightCode } from "./highlight.js";
export { domToMarkdown, getCursorMarkdownOffset } from "./serialize.js";
export { checkBlockInputTransform, handleBlockTransform } from "./transforms.js";
export { checkInlineTransform } from "./inline-transforms.js";
export { computeDiff, renderDiff } from "./diff.js";
export type { DiffHunk, DiffLine } from "./diff.js";
export { merge3 } from "./merge.js";
export {
  escapeHtml,
  stemFromPath,
  clampNodeOffset,
  CURSOR_SENTINEL,
  BLOCK_TAGS,
  isBlockTag,
} from "./util.js";
export {
  MAX_HEADING_LEVEL,
  CODE_FENCE_MARKER_LENGTH,
  LIST_INDENT_SPACES,
  INLINE_TRANSFORM_SEARCH_LIMIT,
  DIFF_CONTEXT_LINES,
} from "./constants.js";
export {
  toggleBold,
  toggleItalic,
  toggleStrikethrough,
  toggleHighlight,
  toggleHeading,
  toggleCodeFence,
  shiftIndent,
  clearInlineFormats,
} from "./format-ops.js";
export type { FormatResult } from "./format-ops.js";
export { createEditor } from "./editor.js";
export type { EditorConfig, EditorHandle } from "./editor.js";
