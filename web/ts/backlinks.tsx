import { stemFromPath } from "@joshuarli98/md-wysiwyg";
import { For } from "solid-js";
import { render } from "solid-js/web";

import { getBacklinks } from "./api.ts";
import { openTab } from "./tab-state.ts";

import styles from "./editor-adjacent.module.css";

const disposers = new WeakMap<HTMLElement, () => void>();

type BacklinksProps = {
  links: readonly string[];
};

function Backlinks(props: Readonly<BacklinksProps>) {
  return (
    <>
      <div class={styles["backlinksHeader"]} data-ui="backlinks-header">
        {props.links.length} backlink{props.links.length > 1 ? "s" : ""}
      </div>
      <div class={styles["backlinksList"]}>
        <For each={props.links}>
          {(linkPath) => (
            <button
              type="button"
              class={styles["backlinkItem"]}
              data-ui="backlink-item"
              onClick={() => openTab(linkPath)}
            >
              {stemFromPath(linkPath)}
            </button>
          )}
        </For>
      </div>
    </>
  );
}

function clearBacklinks(el: HTMLElement) {
  disposers.get(el)?.();
  disposers.delete(el);
  el.textContent = "";
}

/// Load and render backlinks for a note into the given container.
export async function loadBacklinks(el: HTMLElement, path: string) {
  clearBacklinks(el);

  try {
    const links = await getBacklinks(path);
    if (links.length === 0) {
      el.style.display = "none";
      return;
    }

    el.style.display = "";
    const dispose = render(() => <Backlinks links={links} />, el);
    disposers.set(el, dispose);
  } catch {
    el.style.display = "none";
  }
}
