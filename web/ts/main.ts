import { stemFromPath } from "@joshuarli98/md-wysiwyg";

import {
  renameNote,
  getNote,
  listNotes,
  getStatus,
  unlockWithRecoveryKey,
  unlockWithPrf,
  type AppStatus,
} from "./api.ts";
import { initEditor, invalidateNoteCache, type EditorInstance } from "./editor.ts";
import { emit, on } from "./events.ts";
import { initFileNav } from "./filenav.ts";
import { openStore } from "./local-store.ts";
import { createPalette, matchesKey } from "./palette.ts";
import { createSearch } from "./search.ts";
import { createSettings } from "./settings.ts";
import {
  closeActiveTab,
  nextTab,
  prevTab,
  getActiveTab,
  openTab,
  updateTabPath,
  updateTabContent,
  restoreSession,
  reopenClosedTab,
  syncToServer,
} from "./tab-state.ts";
import { promptNewNote } from "./tabs.ts";
import { isPrfLikelySupported, getPrfKey } from "./webauthn.ts";
import { registerWikiLinkClickHandler } from "./wikilinks.ts";

const appEl = document.querySelector("#app") as HTMLElement;
let sse: EventSource | null = null;
let appInitialized = false;
let editor: EditorInstance | null = null;
let sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pageUnloading = false;

function showUnlockScreen(status?: AppStatus) {
  appEl.style.display = "none";

  let screen = document.querySelector("#unlock-screen");
  if (!screen) {
    screen = document.createElement("div");
    screen.id = "unlock-screen";
    document.body.append(screen);
  }

  const hasPrf = status && status.prf_credential_ids.length > 0 && isPrfLikelySupported();

  screen.innerHTML = `
    <h1>tansu</h1>
    <p>This vault is locked.</p>
    ${hasPrf ? '<button id="unlock-biometric" type="button">Unlock with biometrics</button>' : ""}
    <form id="unlock-form">
      <input id="unlock-key" type="text" placeholder="Recovery key" autocomplete="off" spellcheck="false" />
      <button type="submit">Unlock with recovery key</button>
      <div id="unlock-error"></div>
      <div id="unlock-status"></div>
    </form>
  `;

  const form = document.querySelector("#unlock-form") as HTMLFormElement;
  const input = document.querySelector("#unlock-key") as HTMLInputElement;
  const errorEl = document.querySelector("#unlock-error")!;
  const statusEl = document.querySelector("#unlock-status")!;

  function onUnlockSuccess() {
    statusEl.textContent = "Unlocked. Loading...";
    screen!.remove();
    appEl.style.display = "";
    startApp();
  }

  // Biometric unlock button
  if (hasPrf && status) {
    const credIds = status.prf_credential_ids;
    const bioBtn = document.querySelector("#unlock-biometric") as HTMLButtonElement | null;
    if (bioBtn) {
      bioBtn.addEventListener("click", async () => {
        errorEl.textContent = "";
        statusEl.textContent = "Waiting for biometrics...";
        try {
          const prfKeyB64 = await getPrfKey(credIds);
          statusEl.textContent = "Unlocking...";
          const ok = await unlockWithPrf(prfKeyB64);
          if (ok) {
            onUnlockSuccess();
          } else {
            errorEl.textContent = "Biometric unlock failed.";
            statusEl.textContent = "";
          }
        } catch (error) {
          errorEl.textContent = error instanceof Error ? error.message : "Biometric unlock failed.";
          statusEl.textContent = "";
        }
      });
      // Auto-trigger biometric on load
      bioBtn.click();
    }
  } else {
    input.focus();
  }

  // Recovery key form
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = input.value.trim();
    if (!key) {
      return;
    }

    errorEl.textContent = "";
    statusEl.textContent = "Unlocking...";
    const btn = form.querySelector("button[type=submit]") as HTMLButtonElement;
    btn.disabled = true;

    try {
      const ok = await unlockWithRecoveryKey(key);
      if (ok) {
        onUnlockSuccess();
        return;
      }
    } catch {
      // Network error or server crash
    }
    errorEl.textContent = "Unlock failed. Check your recovery key.";
    statusEl.textContent = "";
    btn.disabled = false;
    input.focus();
    input.select();
  });
}

async function startApp() {
  if (!appInitialized) {
    initApp();
    appInitialized = true;
  }
  await openStore();
  if (!sse) connectSSE();
  restoreSession();
}

function initApp() {
  editor = initEditor();
  initFileNav();
  const palette = createPalette();
  const settings = createSettings();
  const search = createSearch({ openTab, invalidateNoteCache });

  registerWikiLinkClickHandler(async (target: string) => {
    const notes = await listNotes();
    const normalized = target.toLowerCase().replaceAll(/\s+/g, "-");
    const match = notes.find((n) => {
      const stem = stemFromPath(n.path).toLowerCase().replaceAll(/\s+/g, "-");
      return stem === normalized;
    });

    if (match) {
      await openTab(match.path);
    } else {
      const path = `${target}.md`;
      const { createNote } = await import("./api.ts");
      await createNote(path);
      invalidateNoteCache();
      await openTab(path);
    }
  });

  on("tab:change", (tab) => {
    if (tab) {
      editor?.showEditor(tab.path, tab.content);
    } else {
      editor?.hideEditor();
    }
  });

  palette.registerCommands([
    {
      label: "Search notes",
      shortcut: "\u2318K",
      keys: { key: "k", meta: true },
      action: () => search.toggle(),
    },
    {
      label: "Search in current note",
      shortcut: "\u2318F",
      keys: { key: "f", meta: true },
      action: () => {
        const tab = getActiveTab();
        if (tab) {
          search.open(tab.path);
        } else {
          search.open();
        }
      },
    },
    {
      label: "Global search",
      shortcut: "\u21E7\u2318F",
      keys: { key: "f", meta: true, shift: true },
      action: () => search.open(),
    },
    {
      label: "New note",
      shortcut: "\u2318N",
      keys: { key: "n", meta: true },
      action: () => promptNewNote(),
    },
    {
      label: "Reopen closed tab",
      shortcut: "\u21E7\u2318T",
      keys: { key: "t", meta: true, shift: true },
      action: () => reopenClosedTab(),
    },
    {
      label: "Save",
      shortcut: "\u2318S",
      keys: { key: "s", meta: true },
      action: () => editor?.saveCurrentNote(),
    },
    {
      label: "Close tab",
      shortcut: "\u2318W",
      keys: { key: "w", meta: true },
      action: () => closeActiveTab(),
    },
    {
      label: "Next tab",
      shortcut: "\u21E7\u2318]",
      keys: { key: "]", meta: true, shift: true },
      action: () => nextTab(),
    },
    {
      label: "Previous tab",
      shortcut: "\u21E7\u2318[",
      keys: { key: "[", meta: true, shift: true },
      action: () => prevTab(),
    },
    {
      label: "Settings",
      shortcut: "\u21E7\u2318S",
      keys: { key: "s", meta: true, shift: true },
      action: () => settings.toggle(),
    },
  ]);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (palette.isOpen()) {
        e.preventDefault();
        palette.close();
        return;
      }
      if (settings.isOpen()) {
        e.preventDefault();
        settings.close();
        return;
      }
      if (search.isOpen()) {
        e.preventDefault();
        search.close();
        return;
      }
      return;
    }

    if ((e.metaKey || e.ctrlKey) && e.key === "p") {
      e.preventDefault();
      palette.toggle();
      return;
    }

    for (const cmd of palette.getCommands()) {
      if (cmd.keys && matchesKey(e, cmd.keys)) {
        e.preventDefault();
        cmd.action();
        return;
      }
    }
  });

  on("file:rename", async ({ oldPath, newPath }) => {
    try {
      const result = await renameNote(oldPath, newPath);
      invalidateNoteCache();
      emit("files:changed");
      updateTabPath(oldPath, newPath);

      await Promise.all(
        result.updated.map(async (updated) => {
          try {
            const note = await getNote(updated);
            updateTabContent(updated, note.content, note.mtime);
          } catch {
            /* reload failed silently */
          }
        }),
      );

      const active = getActiveTab();
      if (active && active.path === newPath) {
        editor?.showEditor(active.path, active.content);
      }
    } catch {
      /* rename failed silently */
    }
  });
}

// Notification pill
const notif = document.querySelector("#notification")!;
let notifTimer: ReturnType<typeof setTimeout> | null = null;

function showNotification(msg: string, type: "error" | "info" | "success" = "error") {
  notif.textContent = msg;
  notif.className = `notification ${type}`;
  if (notifTimer) {
    clearTimeout(notifTimer);
  }
  notifTimer = setTimeout(() => {
    notif.className = "notification hidden";
  }, 5000);
}

on("notification", ({ msg, type }) => showNotification(msg, type));

function createBackoff(delays: number[]) {
  let attempt = 0;
  let unavailable = false;
  return {
    next(): number {
      const delay = delays[Math.min(attempt, delays.length - 1)]!;
      attempt++;
      return delay;
    },
    format(delay: number): string {
      return delay < 1000 ? `${delay}ms` : `${Math.round(delay / 1000)}s`;
    },
    reset() {
      attempt = 0;
    },
    get wasUnavailable() {
      return unavailable;
    },
    set wasUnavailable(v: boolean) {
      unavailable = v;
    },
  };
}

const sseBackoff = createBackoff([250, 250, 500, 1000, 1000, 2000, 5000]);

function requestImmediateSSEReconnect() {
  if (pageUnloading || sse) {
    return;
  }
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }
  connectSSE();
}

function connectSSE() {
  if (sse) {
    sse.close();
    sse = null;
  }
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }
  if (pageUnloading) {
    return;
  }
  const es = new EventSource("/events");
  sse = es;

  es.addEventListener("connected", () => {
    if (sse !== es) return;
    sseBackoff.reset();
    if (sseBackoff.wasUnavailable) {
      sseBackoff.wasUnavailable = false;
      showNotification("Server connection restored.", "success");
    } else {
      notif.className = "notification hidden";
    }
    syncToServer();
  });

  es.addEventListener("changed", async (e) => {
    const path = e.data;
    emit("files:changed", { savedPath: path });
    const active = getActiveTab();
    if (active && active.path === path) {
      try {
        const note = await getNote(path);
        editor?.reloadFromDisk(note.content, note.mtime);
      } catch {
        /* reload failed silently */
      }
    }
  });

  es.addEventListener("deleted", (e) => {
    const path = e.data;
    invalidateNoteCache();
    emit("files:changed", {});
    const active = getActiveTab();
    if (active && active.path === path) {
      showNotification(`"${stemFromPath(path)}" was deleted externally.`);
      closeActiveTab();
    }
  });

  es.addEventListener("locked", () => {
    if (sse !== es) return;
    es.close();
    sse = null;
    showUnlockScreen();
  });

  es.onerror = () => {
    if (sse !== es) return;
    es.close();
    sse = null;
    if (pageUnloading) {
      return;
    }
    sseBackoff.wasUnavailable = true;
    const delay = sseBackoff.next();
    showNotification(`Server unavailable — retrying in ${sseBackoff.format(delay)}...`);
    sseReconnectTimer = setTimeout(() => {
      sseReconnectTimer = null;
      connectSSE();
    }, delay);
  };
}

function closeSSEForUnload() {
  pageUnloading = true;
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }
  if (sse) {
    sse.close();
    sse = null;
  }
}

window.addEventListener("pagehide", closeSSEForUnload);
window.addEventListener("beforeunload", closeSSEForUnload);
window.addEventListener("focus", requestImmediateSSEReconnect);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    requestImmediateSSEReconnect();
  }
});

function checkBrowserSupport(): string[] {
  const missing: string[] = [];
  if (!("indexedDB" in window)) {
    missing.push("IndexedDB");
  }
  if (!("EventSource" in window)) {
    missing.push("Server-Sent Events");
  }
  if (!("setHTML" in Element.prototype)) {
    missing.push("HTML Sanitizer API");
  }
  return missing;
}

function showUnsupportedPage(missing: string[]) {
  document.body.innerHTML = `<div style="font-family:sans-serif;max-width:560px;margin:80px auto;padding:0 24px;line-height:1.6">
    <h2 style="margin-top:0">Browser not supported</h2>
    <p>tansu requires features your browser doesn't support:</p>
    <ul>${missing.map((f) => `<li>${f}</li>`).join("")}</ul>
    <p>Please upgrade to <strong>Firefox 148</strong> or later.</p>
    <p style="color:#888;font-size:0.85em;word-break:break-all">Your browser: ${navigator.userAgent}</p>
  </div>`;
}

// Boot: check if encrypted + locked, show unlock or start app
const missingFeatures = checkBrowserSupport();
if (missingFeatures.length > 0) {
  showUnsupportedPage(missingFeatures);
} else {
  (async () => {
    try {
      const status = await getStatus();
      if (status.locked) {
        showUnlockScreen(status);
      } else {
        startApp();
      }
    } catch {
      // Status check failed — server may be down, start normally
      startApp();
    }
  })();
}
