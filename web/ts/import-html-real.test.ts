import { readFileSync } from "node:fs";
import { join } from "node:path";

import { setupDOM } from "./test-helper.ts";

const showAlertDialog = vi.fn(async () => {});
const createNote = vi.fn(async () => ({ mtime: 1 }));
const listNotes = vi.fn(async () => []);
const openTab = vi.fn(async () => {});
const notifyFilesChanged = vi.fn(() => {});
const showNotification = vi.fn(() => {});
const reportActionError = vi.fn(() => {});

vi.mock(import('./alert-dialog.tsx'), async () => {
  const mod = await vi.importActual<typeof import("./alert-dialog.tsx")>("./alert-dialog.tsx");
  return {
    ...mod,
    showAlertDialog,
  };
});

vi.mock(import('./api.ts'), () => ({
  ApiError: class ApiError extends Error {
    status: number;
    context: string;
    body: string | undefined;
    constructor(context: string, status: number, body?: string) {
      super(`${context} failed: ${status}`);
      this.context = context;
      this.status = status;
      this.body = body;
    }
  },
  createNote,
  listNotes,
}));

vi.mock(import('./tab-state.ts'), () => ({
  openTab,
}));

vi.mock(import('./server-store.ts'), () => ({
  serverStore: {
    notifyFilesChanged,
  },
}));

vi.mock(import('./ui-store.ts'), () => ({
  uiStore: {
    showNotification,
  },
}));

vi.mock(import('./notify.ts'), () => ({
  reportActionError,
}));

describe("import html real fixture", () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = setupDOM();
    showAlertDialog.mockClear();
    createNote.mockClear();
    listNotes.mockClear();
    openTab.mockClear();
    notifyFilesChanged.mockClear();
    showNotification.mockClear();
    reportActionError.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("imports fixture html as markdown instead of raw html", async () => {
    const { promptHtmlImport } = await import("./import-html.ts");
    promptHtmlImport();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const fixture = readFileSync(
      join(import.meta.dirname, "fixtures", "import-article.html"),
      "utf8",
    );
    const file = new File([fixture], "import-article.html", { type: "text/html" });
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });

    input.dispatchEvent(new Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(showAlertDialog).not.toHaveBeenCalled();
    expect(createNote).toHaveBeenCalledOnce();
    const calls = createNote.mock.calls as unknown as [string, string][];
    expect(calls[0]).toBeDefined();
    const [path, content] = calls[0]!;
    expect(path).toBe("import-article.md");
    expect(content).toContain('title: "Fixture Import"');
    expect(content).toContain('author: "Fixture Author"');
    expect(content).toContain("Intro paragraph with **bold** text.");
    expect(content).toContain("First item");
    expect(content).toContain("Closing paragraph.");
    expect(content).not.toContain("<article");
    expect(content).not.toContain("<p>");
    expect(content).not.toContain("<h1>");
    expect(reportActionError).not.toHaveBeenCalled();
  });
});
