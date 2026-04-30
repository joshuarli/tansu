import Defuddle from "defuddle/full";

import { showAlertDialog } from "./alert-dialog.tsx";
import { ApiError, createNote, listNotes } from "./api.ts";
import { reportActionError } from "./notify.ts";
import { serverStore } from "./server-store.ts";
import { openTab } from "./tab-state.ts";
import { uiStore } from "./ui-store.ts";

let pickerEl: HTMLInputElement | null = null;

class HtmlImportError extends Error {}

function ensurePicker(): HTMLInputElement {
  if (pickerEl) {
    return pickerEl;
  }

  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".html,.htm,text/html";
  input.style.display = "none";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) {
      return;
    }
    void importSelectedFile(file);
  });
  document.body.append(input);
  pickerEl = input;
  return input;
}

async function importSelectedFile(file: File): Promise<void> {
  try {
    const path = await createImportedNote(file);
    serverStore.notifyFilesChanged();
    await openTab(path);
    uiStore.showNotification(`Imported ${file.name}`, "success");
  } catch (error) {
    if (error instanceof HtmlImportError) {
      await showAlertDialog("Import failed", error.message);
      return;
    }
    reportActionError(`Failed to import ${file.name}`, error);
  }
}

function importStemFromFilename(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/u, "");
  const sanitized = stem.trim().replaceAll(/[/:\\\0]/gu, "-");
  return sanitized || "import";
}

function nextImportPath(stem: string, existingPaths: ReadonlySet<string>): string {
  let path = `${stem}.md`;
  let counter = 1;
  while (existingPaths.has(path)) {
    path = `${stem}-${counter}.md`;
    counter++;
  }
  return path;
}

function buildFrontmatter(fields: Readonly<Record<string, string | undefined>>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

function buildImportedMarkdown(
  result: Readonly<{
    title: string;
    published: string;
    author: string;
    description: string;
    content: string;
    contentMarkdown?: string;
  }>,
): string {
  const frontmatter = buildFrontmatter({
    title: result.title,
    date: result.published,
    author: result.author,
    description: result.description,
  });
  return `${frontmatter}\n${result.contentMarkdown ?? result.content}\n`;
}

function requireMarkdownContent(
  fileName: string,
  result: Readonly<{ contentMarkdown?: string }>,
): string {
  if (!result.contentMarkdown) {
    throw new HtmlImportError(
      `Defuddle did not produce Markdown for "${fileName}". Import was cancelled to avoid saving HTML into a note.`,
    );
  }
  return result.contentMarkdown;
}

async function createImportedNote(file: File): Promise<string> {
  const html = await file.text();
  const baseUrl = URL.createObjectURL(file);
  try {
    const document = new DOMParser().parseFromString(html, "text/html");
    const result = new Defuddle(document, {
      url: baseUrl,
      separateMarkdown: true,
      useAsync: false,
    }).parse();
    const contentMarkdown = requireMarkdownContent(file.name, result);
    const content = buildImportedMarkdown({ ...result, contentMarkdown });
    const existingPaths = new Set((await listNotes()).map((note) => note.path));
    const stem = importStemFromFilename(file.name);
    let path = nextImportPath(stem, existingPaths);

    for (;;) {
      try {
        await createNote(path, content);
        return path;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) {
          throw error;
        }
        existingPaths.add(path);
        path = nextImportPath(stem, existingPaths);
      }
    }
  } finally {
    URL.revokeObjectURL(baseUrl);
  }
}

export function promptHtmlImport(): void {
  const input = ensurePicker();
  input.value = "";
  input.click();
}
