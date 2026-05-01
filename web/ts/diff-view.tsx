import type { DiffHunk } from "@joshuarli98/md-wysiwyg";
import { For, Show } from "solid-js";

import styles from "./editor-adjacent.module.css";

type Props = {
  hunks: DiffHunk[];
  class?: string;
};

export function DiffView(props: Readonly<Props>) {
  return (
    <div
      class={props.class ? `${styles["diffView"]} ${props.class}` : styles["diffView"]}
      data-ui="diff-view"
    >
      <Show when={() => props.hunks.length > 0} fallback="No changes.">
        <For each={props.hunks}>
          {(hunk) => (
            <div class={styles["diffHunk"]}>
              <div class={styles["diffHunkHeader"]}>
                @@ -{hunk.oldStart + 1} +{hunk.newStart + 1} @@
              </div>
              <For each={hunk.lines}>
                {(line) => {
                  const prefix = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
                  const lineClass =
                    line.type === "add"
                      ? styles["diffAdd"]
                      : line.type === "del"
                        ? styles["diffDel"]
                        : styles["diffCtx"];
                  return (
                    <div class={`${styles["diffLine"]} ${lineClass}`}>
                      <span class={styles["diffPrefix"]}>{prefix}</span>
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
