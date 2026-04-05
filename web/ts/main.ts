import {
  renameNote,
  getNote,
  listNotes,
  getStatus,
  unlockWithRecoveryKey,
  unlockWithPrf,
  type AppStatus,
} from "./api.ts";
import {
  initEditor,
  showEditor,
  hideEditor,
  saveCurrentNote,
  reloadFromDisk,
  invalidateNoteCache,
} from "./editor.ts";
import { on } from "./events.ts";
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
  createNewNote,
} from "./tabs.ts";
import type { Tab } from "./tabs.ts";
import { stemFromPath } from "./util.ts";
import { isPrfLikelySupported, getPrfKey } from "./webauthn.ts";
import { registerWikiLinkClickHandler } from "./wikilinks.ts";

const appEl = document.getElementById("app")!;
let sse: EventSource | null = null;
let appInitialized = false;

function showUnlockScreen(status?: AppStatus) {
  appEl.style.display = "none";

  let screen = document.getElementById("unlock-screen");
  if (!screen) {
    screen = document.createElement("div");
    screen.id = "unlock-screen";
    document.body.appendChild(screen);
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

  const form = document.getElementById("unlock-form") as HTMLFormElement;
  const input = document.getElementById("unlock-key") as HTMLInputElement;
  const errorEl = document.getElementById("unlock-error")!;
  const statusEl = document.getElementById("unlock-status")!;

  function onUnlockSuccess() {
    statusEl.textContent = "Unlocked. Loading...";
    screen!.remove();
    appEl.style.display = "";
    startApp();
  }

  // Biometric unlock button
  if (hasPrf) {
    const bioBtn = document.getElementById("unlock-biometric")!;
    bioBtn.addEventListener("click", async () => {
      errorEl.textContent = "";
      statusEl.textContent = "Waiting for biometrics...";
      try {
        const prfKeyB64 = await getPrfKey(status.prf_credential_ids);
        statusEl.textContent = "Unlocking...";
        const ok = await unlockWithPrf(prfKeyB64);
        if (ok) {
          onUnlockSuccess();
        } else {
          errorEl.textContent = "Biometric unlock failed.";
          statusEl.textContent = "";
        }
      } catch (e) {
        errorEl.textContent = e instanceof Error ? e.message : "Biometric unlock failed.";
        statusEl.textContent = "";
      }
    });
    // Auto-trigger biometric on load
    (document.getElementById("unlock-biometric") as HTMLButtonElement).click();
  } else {
    input.focus();
  }

  // Recovery key form
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = input.value.trim();
    if (!key) return;

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

function startApp() {
  if (!appInitialized) {
    initApp();
    appInitialized = true;
  }
  connectSSE();
  restoreSession();
}

function initApp() {
  initEditor();
  const palette = createPalette();
  const settings = createSettings();
  const search = createSearch({ openTab, invalidateNoteCache });

  registerWikiLinkClickHandler(async (target: string) => {
    const notes = await listNotes();
    const normalized = target.toLowerCase().replace(/\s+/g, "-");
    const match = notes.find((n) => {
      const stem = stemFromPath(n.path).toLowerCase().replace(/\s+/g, "-");
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

  on<Tab | null>("tab:change", (tab) => {
    if (tab) {
      showEditor(tab.path, tab.content);
    } else {
      hideEditor();
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
        if (tab) search.open(tab.path);
        else search.open();
      },
    },
    {
      label: "Global search",
      shortcut: "\u21e7\u2318F",
      keys: { key: "f", meta: true, shift: true },
      action: () => search.open(),
    },
    {
      label: "New note",
      shortcut: "\u2318T",
      keys: { key: "t", meta: true },
      action: () => createNewNote(),
    },
    {
      label: "Save",
      shortcut: "\u2318S",
      keys: { key: "s", meta: true },
      action: () => saveCurrentNote(),
    },
    {
      label: "Close tab",
      shortcut: "\u2318W",
      keys: { key: "w", meta: true },
      action: () => closeActiveTab(),
    },
    {
      label: "Next tab",
      shortcut: "\u21e7\u2318]",
      keys: { key: "]", meta: true, shift: true },
      action: () => nextTab(),
    },
    {
      label: "Previous tab",
      shortcut: "\u21e7\u2318[",
      keys: { key: "[", meta: true, shift: true },
      action: () => prevTab(),
    },
    {
      label: "Settings",
      shortcut: "\u21e7\u2318S",
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

  window.addEventListener("tansu:rename", async (ev: Event) => {
    const detail = (ev as CustomEvent).detail as { path: string; newName: string };
    const oldPath = detail.path;
    const dir = oldPath.includes("/") ? oldPath.substring(0, oldPath.lastIndexOf("/") + 1) : "";
    const newPath = `${dir}${detail.newName}.md`;

    try {
      const result = await renameNote(oldPath, newPath);
      invalidateNoteCache();
      updateTabPath(oldPath, newPath);

      await Promise.all(
        result.updated.map(async (updated) => {
          try {
            const note = await getNote(updated);
            updateTabContent(updated, note.content, note.mtime);
          } catch (e) {
            console.warn("Failed to reload tab after rename:", e);
          }
        }),
      );

      const active = getActiveTab();
      if (active && active.path === newPath) {
        showEditor(active.path, active.content);
      }
    } catch (e) {
      console.error("Rename failed:", e);
    }
  });
}

// Notification pill
const notif = document.getElementById("notification")!;
let notifTimer: ReturnType<typeof setTimeout> | null = null;

function showNotification(msg: string, type: "error" | "info" = "error") {
  notif.textContent = msg;
  notif.className = `notification ${type}`;
  if (notifTimer) clearTimeout(notifTimer);
  notifTimer = setTimeout(() => {
    notif.className = "notification hidden";
  }, 5000);
}

let sseBackoff = 1000;

function connectSSE() {
  if (sse) {
    sse.close();
    sse = null;
  }
  const es = new EventSource("/events");
  sse = es;

  es.addEventListener("connected", () => {
    sseBackoff = 1000;
    notif.className = "notification hidden";
  });

  es.addEventListener("changed", async (e) => {
    const path = e.data;
    const active = getActiveTab();
    if (active && active.path === path) {
      try {
        const note = await getNote(path);
        reloadFromDisk(note.content, note.mtime);
      } catch (err) {
        console.warn("Failed to reload note from disk:", err);
      }
    }
  });

  es.addEventListener("deleted", (e) => {
    const path = e.data;
    invalidateNoteCache();
    const active = getActiveTab();
    if (active && active.path === path) {
      alert(`"${stemFromPath(path)}" was deleted externally.`);
      closeActiveTab();
    }
  });

  es.addEventListener("locked", () => {
    es.close();
    sse = null;
    showUnlockScreen();
  });

  es.onerror = () => {
    es.close();
    sse = null;
    showNotification(`Live reload disconnected — retrying in ${Math.round(sseBackoff / 1000)}s...`);
    setTimeout(connectSSE, sseBackoff);
    sseBackoff = Math.min(sseBackoff * 2, 30000);
  };
}

// Boot: check if encrypted + locked, show unlock or start app
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
