import { describe, test, expect, afterAll } from "bun:test";

import {
  searchNotes,
  getNote,
  saveNote,
  createNote,
  deleteNote,
  renameNote,
  listNotes,
  getBacklinks,
  uploadImage,
  listRevisions,
  getRevision,
  restoreRevision,
  getState,
  saveState,
  getSettings,
  saveSettings,
  unlockWithRecoveryKey,
  unlockWithPrf,
  lockApp,
  registerPrf,
  removePrf,
  getStatus,
} from "./api.ts";
import { mockFetch } from "./test-helper.ts";

const mock = mockFetch();

afterAll(() => {
  mock.restore();
});

describe("api", () => {
  test("searchNotes returns results", async () => {
    mock.on("GET", "/api/search", [
      {
        path: "a.md",
        title: "A",
        excerpt: "",
        score: 1,
        field_scores: { title: 1, headings: 0, tags: 0, content: 0 },
      },
    ]);
    const results = await searchNotes("test");
    expect(results.length).toBe(1);
    expect(results[0]!.path).toBe("a.md");
  });

  test("searchNotes with path scope", async () => {
    mock.on("GET", "/api/search", []);
    const scoped = await searchNotes("test", "notes/a.md");
    expect(scoped.length).toBe(0);
  });

  test("getNote", async () => {
    mock.on("GET", "/api/note", { content: "# Hello", mtime: 1000 });
    const note = await getNote("test.md");
    expect(note.content).toBe("# Hello");
    expect(note.mtime).toBe(1000);
  });

  test("saveNote success", async () => {
    mock.on("PUT", "/api/note", { mtime: 2000 });
    const saved = await saveNote("test.md", "# Updated", 1000);
    expect(saved.mtime).toBe(2000);
    expect(saved.conflict).toBe(undefined);
  });

  test("saveNote conflict", async () => {
    mock.on("PUT", "/api/note", { mtime: 3000, content: "# Conflict" }, 409);
    const conflict = await saveNote("test.md", "# Mine", 1000);
    expect(conflict.conflict).toBe(true);
    expect(conflict.content).toBe("# Conflict");
  });

  test("createNote", async () => {
    mock.on("POST", "/api/note", { mtime: 4000 });
    const created = await createNote("new.md");
    expect(created.mtime).toBe(4000);
  });

  test("deleteNote", async () => {
    mock.on("DELETE", "/api/note", {});
    await deleteNote("old.md"); // should not throw
  });

  test("renameNote", async () => {
    mock.on("POST", "/api/rename", { updated: ["a.md", "b.md"] });
    const renamed = await renameNote("old.md", "new.md");
    expect(renamed.updated.length).toBe(2);
  });

  test("listNotes", async () => {
    mock.on("GET", "/api/notes", [{ path: "a.md", title: "A" }]);
    const notes = await listNotes();
    expect(notes.length).toBe(1);
  });

  test("getBacklinks", async () => {
    mock.on("GET", "/api/backlinks", ["ref.md"]);
    const backlinks = await getBacklinks("test.md");
    expect(backlinks[0]).toBe("ref.md");
  });

  test("uploadImage", async () => {
    mock.on("POST", "/api/image", { filename: "img.webp" });
    const blob = new Blob(["data"], { type: "image/webp" });
    const filename = await uploadImage(blob, "img.webp");
    expect(filename).toBe("img.webp");
  });

  test("listRevisions", async () => {
    mock.on("GET", "/api/revisions", [1000, 2000]);
    const revisions = await listRevisions("test.md");
    expect(revisions.length).toBe(2);
  });

  test("getRevision", async () => {
    mock.on("GET", "/api/revision", { content: "# Old" });
    const rev = await getRevision("test.md", 1000);
    expect(rev).toBe("# Old");
  });

  test("restoreRevision", async () => {
    mock.on("POST", "/api/restore", { mtime: 5000 });
    const restored = await restoreRevision("test.md", 1000);
    expect(restored.mtime).toBe(5000);
  });

  test("getState", async () => {
    mock.on("GET", "/api/state", { tabs: ["a.md"], active: 0 });
    const state = await getState();
    expect(state.tabs!.length).toBe(1);
  });

  test("saveState", async () => {
    mock.on("PUT", "/api/state", {});
    await saveState({ tabs: ["a.md"], active: 0 }); // should not throw
  });

  test("getSettings", async () => {
    mock.on("GET", "/api/settings", {
      weight_title: 10,
      weight_headings: 5,
      weight_tags: 2,
      weight_content: 1,
      fuzzy_distance: 1,
      result_limit: 20,
      show_score_breakdown: true,
      excluded_folders: [],
    });
    const settings = await getSettings();
    expect(settings.weight_title).toBe(10);
  });

  test("saveSettings", async () => {
    mock.on("PUT", "/api/settings", {});
    const settings = {
      weight_title: 10,
      weight_headings: 5,
      weight_tags: 2,
      weight_content: 1,
      fuzzy_distance: 1,
      result_limit: 20,
      show_score_breakdown: true,
      excluded_folders: [] as string[],
    };
    await saveSettings(settings); // should not throw
  });

  test("listNotes error", async () => {
    mock.on("GET", "/api/notes", {}, 500);
    await expect(listNotes()).rejects.toThrow();
  });

  test("unlockWithRecoveryKey returns true on 200", async () => {
    mock.on("POST", "/api/unlock", {}, 200);
    const result = await unlockWithRecoveryKey("recovery-key-123");
    expect(result).toBe(true);
  });

  test("unlockWithRecoveryKey returns false on 403", async () => {
    mock.on("POST", "/api/unlock", {}, 403);
    const result = await unlockWithRecoveryKey("bad-key");
    expect(result).toBe(false);
  });

  test("unlockWithPrf returns true on 200", async () => {
    mock.on("POST", "/api/unlock", {}, 200);
    const result = await unlockWithPrf("prf-key-b64");
    expect(result).toBe(true);
  });

  test("lockApp calls fetch", async () => {
    mock.on("GET", "/api/lock", {});
    await lockApp(); // should not throw
  });

  test("registerPrf returns true on 200", async () => {
    mock.on("POST", "/api/prf/register", {}, 200);
    const result = await registerPrf("cred-id", "prf-key-b64", "My Key");
    expect(result).toBe(true);
  });

  test("removePrf returns true on 200", async () => {
    mock.on("POST", "/api/prf/remove", {}, 200);
    const result = await removePrf("cred-id");
    expect(result).toBe(true);
  });

  test("getStatus returns status object", async () => {
    mock.on("GET", "/api/status", {
      locked: false,
      encrypted: true,
      needs_setup: false,
      prf_credential_ids: ["cred1"],
      prf_credential_names: ["Key 1"],
    });
    const status = await getStatus();
    expect(status.encrypted).toBe(true);
    expect(status.locked).toBe(false);
    expect(status.prf_credential_ids.length).toBe(1);
  });
});
