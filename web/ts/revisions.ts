import { listRevisions, getRevision, restoreRevision } from "./api.ts";
import { emit } from "./events.ts";
import { relativeTime } from "./util.ts";

let panelEl: HTMLElement | null = null;
let currentPath: string | null = null;

export function toggleRevisions(path: string) {
  if (panelEl && currentPath === path) {
    hideRevisions();
    return;
  }
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
        const content = await getRevision(path, ts);
        // Preview: show content in a temporary read-only view
        const preview = panel.querySelector(".revision-preview");
        if (preview) preview.remove();
        const pre = document.createElement("pre");
        pre.className = "revision-preview";
        pre.style.cssText =
          "font-size:12px;max-height:300px;overflow:auto;background:#f6f8fa;padding:8px;border-radius:6px;margin-top:8px;white-space:pre-wrap;word-break:break-word;";
        pre.textContent = content;
        panel.appendChild(pre);
      };

      panel.appendChild(item);
    }
  } catch {
    loading.textContent = "Failed to load revisions.";
  }
}
