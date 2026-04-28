import { merge3 } from "@joshuarli98/md-wysiwyg";
import { render } from "solid-js/web";

import { forceSaveNote } from "./api.ts";
import { markClean, type Tab } from "./tab-state.ts";

type ConflictBannerProps = {
  currentPath: string;
  diskContent: string;
  diskMtime: number;
  loadContent: (md: string) => void;
  getCurrentContent: () => string;
  onClose: () => void;
};

function ConflictBanner(props: Readonly<ConflictBannerProps>) {
  return (
    <div class="conflict-banner">
      <span>File changed externally - conflicts detected.</span>
      <button
        onClick={() => {
          props.onClose();
          const content = props.getCurrentContent();
          void forceSaveNote(props.currentPath, content)
            .then((r) => markClean(props.currentPath, content, r.mtime))
            .catch(() => void 0);
        }}
      >
        Keep mine
      </button>
      <button
        onClick={() => {
          props.onClose();
          props.loadContent(props.diskContent);
          markClean(props.currentPath, props.diskContent, props.diskMtime);
        }}
      >
        Take theirs
      </button>
    </div>
  );
}

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
) {
  removeConflictBanner(container);

  const host = document.createElement("div");
  host.className = "conflict-banner-host";
  container.prepend(host);

  const dispose = render(
    () => (
      <ConflictBanner
        currentPath={currentPath}
        diskContent={diskContent}
        diskMtime={diskMtime}
        loadContent={loadContent}
        getCurrentContent={getCurrentContent}
        onClose={() => {
          dispose();
          host.remove();
        }}
      />
    ),
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
) {
  const base = tab.content;
  const ours = getCurrentContent();
  const theirs = diskContent;

  const merged = merge3(base, ours, theirs);
  if (merged !== null) {
    loadContent(merged);
    tab.content = diskContent;
    tab.mtime = diskMtime;
    return;
  }

  showConflictBanner(
    container,
    currentPath,
    diskContent,
    diskMtime,
    loadContent,
    getCurrentContent,
  );
}
