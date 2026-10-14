import { createCodeMirrorEditor } from "../codemirror-adapter.js";

const editor = createCodeMirrorEditor(document.querySelector<HTMLElement>("#editor")!, {
  onChange: () => {
    document.querySelector<HTMLOutputElement>("#snapshot")!.value =
      editor.getSnapshot()?.source ?? "";
  },
});
const session = editor.createSession("fixture", "# Editor fixture\n\nType here.\n");
editor.attachSession(session);
