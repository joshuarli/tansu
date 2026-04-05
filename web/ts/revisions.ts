import { listRevisions, getRevision, restoreRevision } from "./api.ts";
import { computeDiff, renderDiff } from "@joshuarli98/md-wysiwyg";
import { emit } from "./events.ts";
import { relativeTime } from "./util.ts";

let hostEl: HTMLElement | null = null;
let currentPath: string | null = null;
let getContent: (() => string) | null = null;
let onHide: (() => void) | null = null;

interface RevisionsOpts {
  path: string;
  host: HTMLElement;
  getCurrentContent: () => string;
  onHide: () => void;
}

export function toggleRevisions(opts: RevisionsOpts) {
  if (hostEl && currentPath === opts.path) {
    hideRevisions();
    return;
  }
  getContent = opts.getCurrentContent;
  onHide = opts.onHide;
  showRevisions(opts.path, opts.host);
}

export function hideRevisions() {
  if (hostEl) {
    hostEl.innerHTML = "";
    hostEl = null;
    currentPath = null;
    if (onHide) onHide();
  }
}

export function isRevisionsOpen(): boolean {
  return hostEl !== null;
}

async function showRevisions(path: string, host: HTMLElement) {
  hideRevisions();
  currentPath = path;
  hostEl = host;
  host.innerHTML = "";

  const header = document.createElement("div");
  header.className = "revisions-header";
  header.innerHTML = `<span>Revisions</span>`;
  const closeBtn = document.createElement("span");
  closeBtn.textContent = "\u00d7";
  closeBtn.style.cursor = "pointer";
  closeBtn.onclick = hideRevisions;
  header.appendChild(closeBtn);
  host.appendChild(header);

  const loading = document.createElement("div");
  loading.textContent = "Loading...";
  loading.style.fontSize = "13px";
  loading.style.color = "#57606a";
  host.appendChild(loading);

  try {
    const timestamps = await listRevisions(path);
    loading.remove();

    if (timestamps.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No revisions yet.";
      empty.style.fontSize = "13px";
      empty.style.color = "#57606a";
      host.appendChild(empty);
      return;
    }

    for (const ts of timestamps) {
      const item = document.createElement("div");
      item.className = "revision-item";

      const time = document.createElement("span");
      time.textContent = relativeTime(ts);

      const restore = document.createElement("span");
      restore.className = "restore-btn";
      restore.textContent = "Restore";
      restore.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm("Restore this revision? Current content will be saved as a new revision."))
          return;
        const result = await restoreRevision(path, ts);
        const content = await getRevision(path, ts);
        emit("revision:restore", { content, mtime: result.mtime });
        hideRevisions();
      };

      item.append(time, restore);
      item.onclick = async () => {
        const revContent = await getRevision(path, ts);
        const preview = host.querySelector(".revision-preview");
        if (preview) preview.remove();
        const current = getContent ? getContent() : "";
        // Diff from current → revision: shows what restoring would change
        const hunks = computeDiff(current, revContent);
        const diffEl = renderDiff(hunks);
        diffEl.classList.add("revision-preview");
        host.appendChild(diffEl);
      };

      host.appendChild(item);
    }
  } catch {
    loading.textContent = "Failed to load revisions.";
  }
}
