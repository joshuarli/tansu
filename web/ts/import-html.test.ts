import { setupDOM } from "./test-helper.ts";

const showAlertDialog = vi.fn(async () => {});
const createNote = vi.fn(async () => ({ mtime: 1 }));
const listNotes = vi.fn(async () => []);
const openTab = vi.fn(async () => {});
const notifyFilesChanged = vi.fn(() => {});
const showNotification = vi.fn(() => {});
const reportActionError = vi.fn(() => {});

vi.mock(import('defuddle/full'), () => ({
  default: vi.fn(),
}));

vi.mock(import('./alert-dialog.tsx'), () => ({
  showAlertDialog,
}));

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

describe("import html", () => {
  let cleanup: () => void;

  beforeEach(() => {
    vi.resetModules();
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

  it("shows an alert and cancels when defuddle does not return markdown", async () => {
    const { default: Defuddle } = await import("defuddle/full");
    vi.mocked(Defuddle).mockImplementation(function MockDefuddle() {
      return {
        parse: () => ({
          title: "Article",
          published: "",
          author: "",
          description: "",
          content: "<article><p>html only</p></article>",
        }),
      };
    } as never);

    const { promptHtmlImport } = await import("./import-html.ts");
    promptHtmlImport();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["<html><body>hello</body></html>"], "sample.html", {
      type: "text/html",
    });
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });

    input.dispatchEvent(new Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(showAlertDialog).toHaveBeenCalledWith(
      "Import failed",
      expect.stringContaining("did not produce Markdown"),
    );
    expect(createNote).not.toHaveBeenCalled();
    expect(openTab).not.toHaveBeenCalled();
    expect(reportActionError).not.toHaveBeenCalled();
  });
});
