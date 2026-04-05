import { saveNote } from "./api.ts";
import { merge3 } from "@joshuarli98/md-wysiwyg";
import { markClean } from "./tabs.ts";
import type { Tab } from "./tabs.ts";

/// Show a conflict banner when disk and editor content diverge.
export function showConflictBanner(
  container: HTMLElement,
  currentPath: string,
  diskContent: string,
  diskMtime: number,
  loadContent: (md: string) => void,
  getCurrentContent: () => string,
) {
  container.querySelector(".conflict-banner")?.remove();

  const banner = document.createElement("div");
  banner.className = "conflict-banner";

  const msg = document.createElement("span");
  msg.textContent = "File changed externally \u2014 conflicts detected.";

  const keepBtn = document.createElement("button");
  keepBtn.textContent = "Keep mine";
  keepBtn.onclick = () => {
    banner.remove();
    const content = getCurrentContent();
    saveNote(currentPath, content, 0).then((r) => {
      markClean(currentPath, content, r.mtime);
    });
  };

  const takeBtn = document.createElement("button");
  takeBtn.textContent = "Take theirs";
  takeBtn.onclick = () => {
    banner.remove();
    loadContent(diskContent);
    markClean(currentPath, diskContent, diskMtime);
  };

  banner.append(msg, keepBtn, takeBtn);
  container.insertBefore(banner, container.firstChild);
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
