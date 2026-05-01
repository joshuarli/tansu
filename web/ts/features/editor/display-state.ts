export type EditorDisplayState =
  | { type: "empty" }
  | { type: "editing" }
  | { type: "source" }
  | { type: "revisions" }
  | { type: "conflict" };

type EditorDisplayStateType = EditorDisplayState["type"];

type EditorDisplayStateController = {
  get(): EditorDisplayState;
  set(state: EditorDisplayState): void;
  setType(type: EditorDisplayStateType): void;
};

export function createEditorDisplayStateController(
  onChange?: (state: EditorDisplayState) => void,
): EditorDisplayStateController {
  let current: EditorDisplayState = { type: "empty" };

  function set(state: EditorDisplayState): void {
    current = state;
    onChange?.(state);
  }

  return {
    get: () => current,
    set,
    setType: (type) => set({ type }),
  };
}
