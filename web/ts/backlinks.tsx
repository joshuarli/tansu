import { stemFromPath } from "@joshuarli98/md-wysiwyg";
import { render } from "solid-js/web";

import { getBacklinks } from "./api.ts";
import { openTab } from "./tab-state.ts";

const disposers = new WeakMap<HTMLElement, () => void>();

type BacklinksProps = {
  links: readonly string[];
};

function Backlinks(props: Readonly<BacklinksProps>) {
  return (
    <>
      <div class="backlinks-header">
        {props.links.length} backlink{props.links.length > 1 ? "s" : ""}
      </div>
      <div class="backlinks-list">
        {props.links.map((linkPath) => (
          <div class="backlink-item" onClick={() => openTab(linkPath)}>
            {stemFromPath(linkPath)}
          </div>
        ))}
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
