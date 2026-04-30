import { merge3 } from "@joshuarli98/md-wysiwyg";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";

import { ConflictBanner } from "./conflict-banner-view.tsx";
import type { Tab } from "./tab-state.ts";

function removeConflictBanner(container: HTMLElement) {
  container.querySelector(".conflict-banner-host")?.remove();
}

export function clearConflictBanner(container: HTMLElement): void {
  removeConflictBanner(container);
}

/// Show a conflict banner when disk and editor content diverge.
export function showConflictBanner(
  container: HTMLElement,
  currentPath: string,
  diskContent: string,
  diskMtime: number,
  loadContent: (md: string) => void,
  getCurrentContent: () => string,
  onClose?: () => void,
) {
  removeConflictBanner(container);

  const host = document.createElement("div");
  host.className = "conflict-banner-host";
  container.prepend(host);

  const dispose = render(
    () =>
      createComponent(ConflictBanner, {
        currentPath,
        diskContent,
        diskMtime,
        loadContent,
        getCurrentContent,
        onClose: () => {
          dispose();
          host.remove();
          onClose?.();
        },
      }),
    host,
  );
}

/// Attempt 3-way merge for dirty tabs; show conflict banner if merge fails.
export function handleReloadConflict(
  tab: Tab,
  container: HTMLElement,
  currentPath: string,
  diskContent: string,
  diskMtime: number,
  loadContent: (md: string) => void,
  getCurrentContent: () => string,
  onClose?: () => void,
): "merged" | "conflict" {
  const base = tab.content;
  const ours = getCurrentContent();
  const theirs = diskContent;

  const merged = merge3(base, ours, theirs);
  if (merged !== null) {
    loadContent(merged);
    tab.content = diskContent;
    tab.mtime = diskMtime;
    return "merged";
  }

  showConflictBanner(
    container,
    currentPath,
    diskContent,
    diskMtime,
    loadContent,
    getCurrentContent,
    onClose,
  );
  return "conflict";
}
