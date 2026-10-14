import { expect, describe, it } from "vitest";

import {
  editableMarkdown,
  frontmatterSupportsTags,
  markdownBody,
  normalizeTag,
  setMarkdownTags,
} from "./markdown-tags.ts";
import { tabFromDocument } from "./state.ts";

describe("markdown tag frontmatter", () => {
  it("treats plain markdown and tags-only frontmatter as editable", () => {
    expect(frontmatterSupportsTags("# Note\n")).toBeTruthy();
    expect(frontmatterSupportsTags("---\ntags:\n  - alpha\n---\n\n# Note\n")).toBeTruthy();
    expect(frontmatterSupportsTags("---\ntitle: Note\n---\n\n# Note\n")).toBeFalsy();
    expect(frontmatterSupportsTags("---\ntags:\n  - alpha\n")).toBeFalsy();
  });

  it("strips supported frontmatter before editor display", () => {
    const tab = tabFromDocument({
      meta: {
        noteId: "n1",
        path: "n.md",
        title: "N",
        tags: ["alpha"],
        revision: 1,
        sourceHash: `sha256-v2:${"a".repeat(64)}`,
        diskHash: `sha256:${"b".repeat(64)}`,
        sourceHashFormatVersion: 2,
        diskHashFormatVersion: 1,
        updatedAtMs: 1,
      },
      content: "---\ntags:\n  - alpha\n---\n\n# Body\n",
    });

    expect(editableMarkdown(tab)).toBe("# Body\n");
  });

  it("normalizes plain note line endings before editor display", () => {
    const tab = tabFromDocument({
      meta: {
        noteId: "n1",
        path: "n.md",
        title: "N",
        tags: [],
        revision: 1,
        sourceHash: `sha256-v2:${"a".repeat(64)}`,
        diskHash: `sha256:${"b".repeat(64)}`,
        sourceHashFormatVersion: 2,
        diskHashFormatVersion: 1,
        updatedAtMs: 1,
      },
      content: "# Body\r\n\r\ntext\r\n",
    });

    expect(editableMarkdown(tab)).toBe("# Body\n\ntext\n");
  });

  it("updates tags while preserving the markdown body", () => {
    expect(setMarkdownTags("# Body\n", ["alpha", "beta"])).toBe(
      "---\ntags:\n  - alpha\n  - beta\n---\n\n# Body\n",
    );
    expect(setMarkdownTags("---\ntags:\n  - old\n---\n\n# Body\n", [])).toBe("# Body\n");
    expect(markdownBody("---\r\ntags:\r\n  - old\r\n---\r\n\r\n# Body\r\n")).toBe("# Body\n");
  });

  it("normalizes user-entered tag values", () => {
    expect(normalizeTag(" #alpha ")).toBe("alpha");
    expect(normalizeTag("")).toBeNull();
    expect(normalizeTag("bad\ntag")).toBeNull();
  });
});
