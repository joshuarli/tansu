import { createCodeMirrorEditor, type EditorSession } from "../codemirror-adapter.js";

type Harness = {
  attachSource(source: string): Promise<number>;
  focusAtEnd(): void;
  prepareSources(sources: string[]): void;
  resetTransactions(): void;
  switchSession(index: number): Promise<number>;
  transactions(): number[];
  snapshot(): { elapsedMs: number; sourceLength: number };
};

declare global {
  interface Window {
    tansuEditorHarness: Harness;
  }
}

const host = document.querySelector<HTMLElement>("#editor")!;
const transactionDurations: number[] = [];
let inputStartedAt: number | null = null;
let sessionNumber = 0;
let sessions: EditorSession[] = [];

host.addEventListener("beforeinput", () => {
  inputStartedAt = performance.now();
}, true);

const editor = createCodeMirrorEditor(host, {
  onChange: ({ revision }) => {
    if (inputStartedAt !== null) {
      transactionDurations.push(performance.now() - inputStartedAt);
      inputStartedAt = null;
    }
    document.querySelector<HTMLOutputElement>("#snapshot")!.value =
      String(revision);
  },
});
const initialSession = editor.createSession("fixture", "# Editor fixture\n\nType here.\n");
editor.attachSession(initialSession);

window.tansuEditorHarness = {
  async attachSource(source) {
    const start = performance.now();
    const session = editor.createSession(`fixture-${++sessionNumber}`, source);
    editor.attachSession(session);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return performance.now() - start;
  },
  focusAtEnd() {
    const snapshot = editor.getSnapshot();
    if (snapshot !== null) {
      editor.revealSelection({ anchor: snapshot.source.length, head: snapshot.source.length });
    }
    editor.focus();
  },
  prepareSources(sources) {
    sessions = sources.map((source) =>
      editor.createSession(`fixture-${++sessionNumber}`, source)
    );
  },
  resetTransactions() {
    transactionDurations.length = 0;
  },
  async switchSession(index) {
    const start = performance.now();
    const session = sessions[index];
    if (session === undefined) throw new Error(`missing editor session ${index}`);
    editor.attachSession(session);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return performance.now() - start;
  },
  transactions() {
    return [...transactionDurations];
  },
  snapshot() {
    const start = performance.now();
    const snapshot = editor.getSnapshot();
    return {
      elapsedMs: performance.now() - start,
      sourceLength: snapshot?.source.length ?? 0,
    };
  },
};
