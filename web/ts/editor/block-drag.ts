import { StateEffect, StateField, Transaction, type EditorState, type Extension, type Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { blockIndexAt, planBlockMove, topLevelBlocks, type SourceBlock } from "./block-ops.js";
import { readOnlyFacet } from "./vendor/atomic/read-only.js";

const SETTLE_MILLISECONDS = 520;
const GRIP_OFFSET = 26;
const GRIP_HOVER_ZONE = 8;

const settleBlock = StateEffect.define<{ from: number; to: number }>();
const clearSettle = StateEffect.define<null>();

const settleDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(clearSettle)) next = Decoration.none;
      if (effect.is(settleBlock)) {
        const ranges: Range<Decoration>[] = [];
        const doc = transaction.state.doc;
        for (let number = doc.lineAt(effect.value.from).number; number <= doc.lineAt(effect.value.to).number; number++) {
          ranges.push(Decoration.line({ class: "tansu-block-settle" }).range(doc.line(number).from));
        }
        next = Decoration.set(ranges);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

let cachedBlocks: { doc: EditorState["doc"]; tree: unknown; blocks: SourceBlock[] } | null = null;

function blocksOf(state: EditorState): SourceBlock[] {
  const tree = syntaxTree(state);
  if (cachedBlocks !== null && cachedBlocks.doc === state.doc && cachedBlocks.tree === tree) {
    return cachedBlocks.blocks;
  }
  const blocks = topLevelBlocks(state);
  cachedBlocks = { doc: state.doc, tree, blocks };
  return blocks;
}

export function moveBlock(view: EditorView, index: number, gap: number): boolean {
  if (view.state.facet(readOnlyFacet)) return false;
  const blocks = blocksOf(view.state);
  const plan = planBlockMove(view.state, blocks, index, gap);
  if (plan === null) return false;
  view.dispatch({
    changes: plan.changes,
    selection: { anchor: plan.movedFrom },
    effects: settleBlock.of({ from: plan.movedFrom, to: plan.movedTo }),
    annotations: Transaction.userEvent.of("move.drop"),
    scrollIntoView: true,
  });
  return true;
}

function dropGap(view: EditorView, blocks: readonly SourceBlock[], y: number): number {
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!;
    const top = view.coordsAtPos(block.from)?.top;
    const bottom = view.coordsAtPos(block.to)?.bottom;
    if (top === undefined || bottom === undefined) continue;
    if (y < (top + bottom) / 2) return index;
  }
  return blocks.length;
}

class BlockDragHandles {
  private readonly grip = document.createElement("div");
  private readonly indicator = document.createElement("div");
  private hovered = -1;
  private dragging: { index: number; gap: number } | null = null;
  private settleTimer: number | null = null;

  constructor(private readonly view: EditorView) {
    this.grip.className = "tansu-block-grip";
    this.grip.setAttribute("role", "button");
    this.grip.setAttribute("aria-label", "Drag block");
    this.grip.textContent = "⠿";
    this.indicator.className = "tansu-block-drop-indicator";
    view.dom.append(this.grip, this.indicator);
    view.contentDOM.addEventListener("mousemove", this.onMouseMove);
    view.dom.addEventListener("mouseleave", this.onMouseLeave);
    this.grip.addEventListener("pointerdown", this.onGripDown);
    this.grip.addEventListener("pointermove", this.onGripMove);
    this.grip.addEventListener("pointerup", this.onGripUp);
    this.grip.addEventListener("pointercancel", this.cancelDrag);
    view.dom.ownerDocument.addEventListener("keydown", this.onKeyDown, true);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.state.facet(readOnlyFacet)) this.hideGrip();
    if (update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(settleBlock)))) {
      if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
      this.settleTimer = window.setTimeout(() => {
        this.settleTimer = null;
        this.view.dispatch({ effects: clearSettle.of(null) });
      }, SETTLE_MILLISECONDS);
    }
  }

  destroy(): void {
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
    this.view.contentDOM.removeEventListener("mousemove", this.onMouseMove);
    this.view.dom.removeEventListener("mouseleave", this.onMouseLeave);
    this.view.dom.ownerDocument.removeEventListener("keydown", this.onKeyDown, true);
    this.grip.remove();
    this.indicator.remove();
  }

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (this.dragging !== null) return;
    if (this.view.state.facet(readOnlyFacet)) {
      this.hideGrip();
      return;
    }
    const content = this.view.contentDOM.getBoundingClientRect();
    const padding = Number.parseFloat(getComputedStyle(this.view.contentDOM).paddingLeft) || 0;
    if (event.clientX > content.left + padding + GRIP_HOVER_ZONE) {
      this.hideGrip();
      return;
    }
    const position = this.view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    const index = blockIndexAt(blocksOf(this.view.state), position ?? -1);
    if (index < 0) {
      this.hideGrip();
      return;
    }
    this.showGrip(index);
  };

  private readonly onMouseLeave = (): void => {
    if (this.dragging === null) this.hideGrip();
  };

  private showGrip(index: number): void {
    const block = blocksOf(this.view.state)[index];
    const coords = block === undefined ? null : this.view.coordsAtPos(block.from);
    if (block === undefined || coords === null) {
      this.hideGrip();
      return;
    }
    this.hovered = index;
    const content = this.view.contentDOM.getBoundingClientRect();
    const padding = Number.parseFloat(getComputedStyle(this.view.contentDOM).paddingLeft) || 0;
    this.grip.style.left = `${Math.max(2, content.left + padding - GRIP_OFFSET)}px`;
    this.grip.style.top = `${coords.top}px`;
    this.grip.classList.add("is-visible");
  }

  private hideGrip(): void {
    this.hovered = -1;
    this.grip.classList.remove("is-visible");
  }

  private readonly onGripDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.hovered < 0 || this.view.state.facet(readOnlyFacet)) return;
    event.preventDefault();
    this.grip.setPointerCapture?.(event.pointerId);
    this.dragging = { index: this.hovered, gap: this.hovered };
    this.view.dom.classList.add("tansu-block-dragging");
  };

  private readonly onGripMove = (event: PointerEvent): void => {
    if (this.dragging === null) return;
    const blocks = blocksOf(this.view.state);
    const gap = dropGap(this.view, blocks, event.clientY);
    this.dragging.gap = gap;
    const edge = gap < blocks.length
      ? this.view.coordsAtPos(blocks[gap]!.from)?.top
      : this.view.coordsAtPos(blocks[blocks.length - 1]!.to)?.bottom;
    if (edge === undefined) return;
    const content = this.view.contentDOM.getBoundingClientRect();
    const padding = Number.parseFloat(getComputedStyle(this.view.contentDOM).paddingLeft) || 0;
    this.indicator.style.left = `${content.left + padding}px`;
    this.indicator.style.width = `${Math.max(0, content.width - padding * 2)}px`;
    this.indicator.style.top = `${edge}px`;
    this.indicator.classList.toggle("is-visible", gap !== this.dragging.index && gap !== this.dragging.index + 1);
  };

  private readonly onGripUp = (event: PointerEvent): void => {
    const drag = this.dragging;
    if (drag === null) return;
    this.onGripMove(event);
    this.endDrag();
    moveBlock(this.view, drag.index, drag.gap);
  };

  private readonly cancelDrag = (): void => this.endDrag();

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.dragging !== null && event.key === "Escape") this.endDrag();
  };

  private endDrag(): void {
    this.dragging = null;
    this.indicator.classList.remove("is-visible");
    this.view.dom.classList.remove("tansu-block-dragging");
    this.hideGrip();
  }
}

export function blockDragHandles(): Extension {
  return [settleDecorations, ViewPlugin.fromClass(BlockDragHandles)];
}
