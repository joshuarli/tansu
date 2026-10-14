export type WikiNote = {
  noteId: string;
  path: string;
  title: string;
};

export type WikiTargetResolution =
  | { kind: "resolved"; note: WikiNote }
  | { kind: "missing"; target: string }
  | { kind: "ambiguous"; target: string; noteIds: readonly string[] }
  | { kind: "invalid"; target: string };

export function resolveWikiTarget(
  target: string,
  currentNotePath: string,
  notes: readonly WikiNote[],
): WikiTargetResolution {
  const requested = normalizeMarkdownPath(target.trim());
  if (requested === null || requested === "") return { kind: "invalid", target };

  const pathMatches = isRootPath(requested) || isRelativePath(requested)
    ? resolveExplicitPath(requested, currentNotePath, notes)
    : requested.includes("/")
    ? null
    : resolveBasename(requested, notes);

  if (pathMatches === null) return { kind: "invalid", target };
  if (pathMatches.length === 0) return { kind: "missing", target };
  if (pathMatches.length > 1) {
    return { kind: "ambiguous", target, noteIds: pathMatches.map((note) => note.noteId) };
  }
  return { kind: "resolved", note: pathMatches[0]! };
}

export function suggestWikiTargets(
  query: string,
  notes: readonly WikiNote[],
): { target: string; label: string; detail: string }[] {
  const folded = query.trim().toLowerCase();
  return notes
    .filter((note) => note.title.toLowerCase().includes(folded))
    .slice(0, 12)
    .map((note) => ({
      target: `/${note.path.replaceAll("\\", "/")}`,
      label: note.title,
      detail: note.path,
    }));
}

function resolveExplicitPath(
  requested: string,
  currentNotePath: string,
  notes: readonly WikiNote[],
): WikiNote[] | null {
  const base = isRootPath(requested)
    ? []
    : directorySegments(currentNotePath);
  const segments = isRootPath(requested) ? requested.slice(1).split("/") : requested.split("/");
  const path: string[] = [...base];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (path.length === 0) return null;
      path.pop();
    } else {
      path.push(segment);
    }
  }
  const resolvedPath = path.join("/").toLowerCase();
  return notes.filter((note) => normalizeMarkdownPath(note.path)?.toLowerCase() === resolvedPath);
}

function resolveBasename(requested: string, notes: readonly WikiNote[]): WikiNote[] {
  const wanted = requested.toLowerCase();
  return notes.filter((note) => basenameWithoutExtension(note.path).toLowerCase() === wanted);
}

function directorySegments(path: string): string[] {
  const segments = normalizeMarkdownPath(path)?.split("/") ?? [];
  segments.pop();
  return segments;
}

function basenameWithoutExtension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.replace(/\.md$/i, "");
}

function normalizeMarkdownPath(path: string): string | null {
  const normalized = path.replaceAll("\\", "/").replace(/\.md$/i, "");
  if (normalized.includes("\0")) return null;
  return normalized;
}

function isRootPath(path: string): boolean {
  return path.startsWith("/");
}

function isRelativePath(path: string): boolean {
  return path.startsWith("./") || path.startsWith("../");
}
