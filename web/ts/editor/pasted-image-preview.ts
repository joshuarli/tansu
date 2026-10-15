import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

type PendingImagePreview = {
  uploadId: number;
  position: number;
  src: string;
};

class PendingImagePreviewWidget extends WidgetType {
  constructor(readonly uploadId: number, readonly src: string) {
    super();
  }

  override eq(other: PendingImagePreviewWidget): boolean {
    return this.uploadId === other.uploadId && this.src === other.src;
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-atomic-image tansu-pasted-image-preview";
    wrapper.dataset["uploadId"] = String(this.uploadId);
    const image = document.createElement("img");
    image.src = this.src;
    image.alt = "Pasted image uploading";
    wrapper.append(image);
    return wrapper;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

export const addPendingImagePreview = StateEffect.define<PendingImagePreview>();
export const removePendingImagePreview = StateEffect.define<number>();

export const pendingImagePreviews = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(addPendingImagePreview)) {
        const position = Math.min(effect.value.position, transaction.state.doc.length);
        const line = transaction.state.doc.lineAt(position);
        next = next.update({
          add: [
            Decoration.widget({
              widget: new PendingImagePreviewWidget(effect.value.uploadId, effect.value.src),
              block: true,
              side: 1,
            }).range(line.to),
          ],
        });
      } else if (effect.is(removePendingImagePreview)) {
        next = next.update({
          filter: (_from, _to, decoration) =>
            !(decoration.spec.widget instanceof PendingImagePreviewWidget &&
              decoration.spec.widget.uploadId === effect.value),
        });
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});
