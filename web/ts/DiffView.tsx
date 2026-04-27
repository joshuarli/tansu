import { For, Show } from "solid-js";
import type { DiffHunk } from "@joshuarli98/md-wysiwyg";

type Props = {
  hunks: DiffHunk[];
  class?: string;
};

export function DiffView(props: Readonly<Props>) {
  return (
    <div class={props.class ? `diff-view ${props.class}` : "diff-view"}>
      <Show when={() => props.hunks.length > 0} fallback="No changes.">
        <For each={props.hunks}>
          {(hunk) => (
            <div class="diff-hunk">
              <div class="diff-hunk-header">
                @@ -{hunk.oldStart + 1} +{hunk.newStart + 1} @@
              </div>
              <For each={hunk.lines}>
                {(line) => {
                  const prefix = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
                  return (
                    <div class={`diff-line diff-${line.type}`}>
                      <span class="diff-prefix">{prefix}</span>
                      {line.text}
                    </div>
                  );
                }}
              </For>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
