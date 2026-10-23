import { describe, expect, it } from "vitest";
import type { V2NoteMeta, V2SearchHit } from "../types.generated.ts";
import { rankTagSuggestions, tagSuggestionQueries } from "./tag-suggestions.ts";

describe("tagSuggestionQueries", () => {
  it("prioritizes heading terms, then repeated body terms, without frontmatter", () => {
    const source = `\uFEFF---\ntags: [yaml, secret]\n---\n# Tidal Marsh\n\nThe wetland notes mention heron twice: heron. Wetland wetland.`;

    expect(tagSuggestionQueries(source)).toStrictEqual(["tidal", "marsh", "wetland", "heron"]);
  });

  it("prioritizes a first-line title when the source has no heading", () => {
    expect(tagSuggestionQueries("Quiet Harbor\n\nThe crossing notes describe ship routes. Ship routes."))
      .toStrictEqual(["quiet", "harbor", "ship", "routes"]);
  });

  it("returns no queries for empty or unterminated frontmatter", () => {
    expect(tagSuggestionQueries("\uFEFF---\ntags: [gardening]\n---\n")).toStrictEqual([]);
    expect(tagSuggestionQueries("---\ntags: hidden\n# Not parsed")).toStrictEqual([]);
  });

  it("keeps useful Unicode terms and limits the source and query count", () => {
    expect(tagSuggestionQueries(`# 東京 Café\n\n${".".repeat(32 * 1024)} orchard`)).toStrictEqual([
      "東京",
      "café",
    ]);
    expect(tagSuggestionQueries(`${".".repeat(32 * 1024)} orchard`)).toStrictEqual([]);
    expect(tagSuggestionQueries("one two three four five six seven")).toHaveLength(4);
  });

  it("removes Markdown destinations and ignores function words", () => {
    expect(tagSuggestionQueries("# The Plan\n\n[field notes](https://example.test/path) at the harbor.")).toStrictEqual([
      "plan",
      "field",
      "notes",
      "harbor",
    ]);
  });
});

describe("rankTagSuggestions", () => {
  it("ranks exact tags by distinct supporting notes and returns canonical note links", () => {
    const far = note("far", "z/far.md", ["alpha", "beta", "beta"]);
    const near = note("near", "a/near.md", ["beta", "alpha"]);
    const middle = note("middle", "m/middle.md", ["beta"]);

    expect(rankTagSuggestions({
      notes: noteMap(far, near, middle),
      hits: [hit(far), hit(near), hit(middle)],
      currentNoteId: null,
      existingTags: [],
    })).toStrictEqual([
      {
        tag: "beta",
        notes: [linked(near), linked(middle), linked(far)],
      },
      {
        tag: "alpha",
        notes: [linked(near), linked(far)],
      },
    ]);
  });

  it("filters self, existing tags, overlays, missing notes, and stale metadata", () => {
    const self = note("self", "self.md", ["self-tag"]);
    const current = note("current", "current.md", ["existing", "shared"]);
    const staleRevision = note("stale-revision", "stale-revision.md", ["shared"], 3);
    const staleHash = note("stale-hash", "stale-hash.md", ["shared"]);

    const suggestions = rankTagSuggestions({
      notes: noteMap(self, current, staleRevision, staleHash),
      hits: [
        hit(self),
        hit(current),
        hit(staleRevision, { revision: 2 }),
        hit(staleHash, { sourceHash: "old-hash" }),
        hit(note("deleted", "deleted.md", ["shared"])),
        { ...hit(current), identity: { kind: "savedOverlay", noteId: "current", localRevision: 2, sourceHash: current.sourceHash } },
        { ...hit(current), identity: { kind: "newLocalDraft", localId: "local-1", localRevision: 1, sourceHash: current.sourceHash } },
      ],
      currentNoteId: "self",
      existingTags: ["existing"],
    });

    expect(suggestions).toStrictEqual([{ tag: "shared", notes: [linked(current)] }]);
  });

  it("deduplicates hits and tags per note, then sorts tied tags and notes stably", () => {
    const later = note("later", "z/later.md", ["omega", "omega", "shared", "beta"]);
    const earlier = note("earlier", "a/earlier.md", ["shared", "alpha"]);

    expect(rankTagSuggestions({
      notes: noteMap(later, earlier),
      hits: [hit(later), hit(earlier), hit(later), hit(later)],
      currentNoteId: null,
      existingTags: [],
    })).toStrictEqual([
      { tag: "shared", notes: [linked(earlier), linked(later)] },
      { tag: "alpha", notes: [linked(earlier)] },
      { tag: "beta", notes: [linked(later)] },
      { tag: "omega", notes: [linked(later)] },
    ]);
  });

  it("caps suggestions at five", () => {
    const only = note("only", "only.md", ["one", "two", "three", "four", "five", "six"]);

    expect(rankTagSuggestions({
      notes: noteMap(only),
      hits: [hit(only)],
      currentNoteId: null,
      existingTags: [],
    })).toHaveLength(5);
  });
});

function note(noteId: string, path: string, tags: string[], revision = 1): V2NoteMeta {
  return {
    noteId,
    path,
    title: noteId,
    tags,
    revision,
    sourceHash: `hash-${noteId}`,
    diskHash: `hash-${noteId}`,
    sourceHashFormatVersion: 1,
    diskHashFormatVersion: 1,
    updatedAtMs: 1,
  };
}

function hit(meta: V2NoteMeta, identity: Partial<{ revision: number; sourceHash: string }> = {}): V2SearchHit {
  return {
    identity: {
      kind: "canonical",
      noteId: meta.noteId,
      revision: identity.revision ?? meta.revision,
      sourceHash: identity.sourceHash ?? meta.sourceHash,
    },
    title: meta.title,
    path: meta.path,
    score: 1,
    excerpt: meta.title,
    excerptRanges: [{ startUtf16: 0, endUtf16: meta.title.length }],
    sourceRange: null,
  };
}

function linked(meta: V2NoteMeta) {
  return { noteId: meta.noteId, path: meta.path, title: meta.title };
}

function noteMap(...notes: V2NoteMeta[]): ReadonlyMap<string, V2NoteMeta> {
  return new Map(notes.map((meta) => [meta.noteId, meta]));
}
