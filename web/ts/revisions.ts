import { listRevisions, getRevision, restoreRevision } from "./api.ts";
import { computeDiff, renderDiff } from "./diff.ts";
import { emit } from "./events.ts";
import { relativeTime } from "./util.ts";

let panelEl: HTMLElement | null = null;
let currentPath: string | null = null;
let getCurrentContent: (() => string) | null = null;

export function toggleRevisions(path: string, getContent?: () => string) {
  if (panelEl && currentPath === path) {
    hideRevisions();
    return;
  }
  if (getContent) getCurrentContent = getContent;
  showRevisions(path);
}

export function hideRevisions() {
  if (panelEl) {
    panelEl.remove();
    panelEl = null;
    currentPath = null;
  }
}

async function showRevisions(path: string) {
  hideRevisions();
  currentPath = path;

  const panel = document.createElement("div");
  panel.className = "revisions-panel";

  const header = document.createElement("div");
  header.className = "revisions-header";
  header.innerHTML = `<span>Revisions</span>`;
  const closeBtn = document.createElement("span");
  closeBtn.textContent = "\u00d7";
  closeBtn.style.cursor = "pointer";
  closeBtn.onclick = hideRevisions;
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const loading = document.createElement("div");
  loading.textContent = "Loading...";
  loading.style.fontSize = "13px";
  loading.style.color = "#57606a";
  panel.appendChild(loading);

  document.body.appendChild(panel);
  panelEl = panel;

  try {
    const timestamps = await listRevisions(path);
    loading.remove();

    if (timestamps.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No revisions yet.";
      empty.style.fontSize = "13px";
      empty.style.color = "#57606a";
      panel.appendChild(empty);
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
        const preview = panel.querySelector(".revision-preview");
        if (preview) preview.remove();
        const current = getCurrentContent ? getCurrentContent() : "";
        const hunks = computeDiff(revContent, current);
        const diffEl = renderDiff(hunks);
        diffEl.classList.add("revision-preview");
        panel.appendChild(diffEl);
      };

      panel.appendChild(item);
    }
  } catch {
    loading.textContent = "Failed to load revisions.";
  }
}
