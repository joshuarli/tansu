import type { EditorAdapter } from "../../editor-adapter.ts";
import { splitFrontmatter, withFrontmatter } from "../../frontmatter.ts";

type ToggleSourceModeOptions = {
  handle: EditorAdapter | null;
  tags: readonly string[];
  setTags: (tags: string[]) => void;
  setDisplayState: (type: "editing" | "source") => void;
};

export function toggleEditorSourceMode(opts: Readonly<ToggleSourceModeOptions>): void {
  const { handle, tags, setTags, setDisplayState } = opts;
  if (!handle) {
    return;
  }

  if (handle.isSourceMode) {
    const markdown = handle.sourceEl.value;
    const parsed = splitFrontmatter(markdown);
    setTags(parsed.hasFrontmatter ? parsed.tags : []);
    handle.sourceEl.value = parsed.hasFrontmatter ? parsed.body : markdown;
    handle.toggleSourceMode();
    setDisplayState("editing");
  } else {
    const body = handle.getValue();
    handle.toggleSourceMode();
    handle.sourceEl.value = withFrontmatter(body, tags);
    setDisplayState("source");
  }
}
