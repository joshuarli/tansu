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
  pinFile,
  unpinFile,
} from "./api.ts";
import { mockFetch } from "./test-helper.ts";

const mock = mockFetch();

afterAll(() => {
  mock.restore();
});

describe("api", () => {
  it("searchNotes returns results", async () => {
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
    expect(results).toHaveLength(1);
    expect(results[0]!.path).toBe("a.md");
  });

  it("searchNotes with path scope", async () => {
    mock.on("GET", "/api/search", []);
    const scoped = await searchNotes("test", "notes/a.md");
    expect(scoped).toHaveLength(0);
  });

  it("getNote", async () => {
    mock.on("GET", "/api/note", { content: "# Hello", mtime: 1000 });
    const note = await getNote("test.md");
    expect(note.content).toBe("# Hello");
    expect(note.mtime).toBe(1000);
  });

  it("saveNote success", async () => {
    mock.on("PUT", "/api/note", { mtime: 2000 });
    const saved = await saveNote("test.md", "# Updated", 1000);
    expect(saved.mtime).toBe(2000);
    expect(saved.conflict).toBeUndefined();
  });

  it("saveNote conflict", async () => {
    mock.on("PUT", "/api/note", { mtime: 3000, content: "# Conflict" }, 409);
    const conflict = await saveNote("test.md", "# Mine", 1000);
    expect(conflict.conflict).toBeTruthy();
    expect(conflict.content).toBe("# Conflict");
  });

  it("createNote", async () => {
    mock.on("POST", "/api/note", { mtime: 4000 });
    const created = await createNote("new.md");
    expect(created.mtime).toBe(4000);
  });

  it("deleteNote", async () => {
    mock.on("DELETE", "/api/note", {});
    await deleteNote("old.md"); // should not throw
  });

  it("renameNote", async () => {
    mock.on("POST", "/api/rename", { updated: ["a.md", "b.md"] });
    const renamed = await renameNote("old.md", "new.md");
    expect(renamed.updated).toHaveLength(2);
  });

  it("listNotes", async () => {
    mock.on("GET", "/api/notes", [{ path: "a.md", title: "A" }]);
    const notes = await listNotes();
    expect(notes).toHaveLength(1);
  });

  it("getBacklinks", async () => {
    mock.on("GET", "/api/backlinks", ["ref.md"]);
    const backlinks = await getBacklinks("test.md");
    expect(backlinks[0]).toBe("ref.md");
  });

  it("uploadImage", async () => {
    mock.on("POST", "/api/image", { filename: "img.webp" });
    const blob = new Blob(["data"], { type: "image/webp" });
    const filename = await uploadImage(blob, "img.webp");
    expect(filename).toBe("img.webp");
  });

  it("listRevisions", async () => {
    mock.on("GET", "/api/revisions", [1000, 2000]);
    const revisions = await listRevisions("test.md");
    expect(revisions).toHaveLength(2);
  });

  it("getRevision", async () => {
    mock.on("GET", "/api/revision", { content: "# Old" });
    const rev = await getRevision("test.md", 1000);
    expect(rev).toBe("# Old");
  });

  it("restoreRevision", async () => {
    mock.on("POST", "/api/restore", { mtime: 5000 });
    const restored = await restoreRevision("test.md", 1000);
    expect(restored.mtime).toBe(5000);
  });

  it("getState", async () => {
    mock.on("GET", "/api/state", { tabs: ["a.md"], active: 0 });
    const state = await getState();
    expect(state.tabs!).toHaveLength(1);
  });

  it("saveState", async () => {
    mock.on("PUT", "/api/state", {});
    await saveState({ tabs: ["a.md"], active: 0 }); // should not throw
  });

  it("getSettings", async () => {
    mock.on("GET", "/api/settings", {
      weight_title: 10,
      weight_headings: 5,
      weight_tags: 2,
      weight_content: 1,
      fuzzy_distance: 1,
      recency_boost: 2,
      result_limit: 20,
      show_score_breakdown: true,
      excluded_folders: [],
    });
    const settings = await getSettings();
    expect(settings.weight_title).toBe(10);
  });

  it("saveSettings", async () => {
    mock.on("PUT", "/api/settings", {});
    const settings = {
      weight_title: 10,
      weight_headings: 5,
      weight_tags: 2,
      weight_content: 1,
      fuzzy_distance: 1,
      recency_boost: 2,
      result_limit: 20,
      show_score_breakdown: true,
      excluded_folders: [] as string[],
    };
    await saveSettings(settings); // should not throw
  });

  it("listNotes error", async () => {
    mock.on("GET", "/api/notes", {}, 500);
    await expect(listNotes()).rejects.toThrow();
  });

  it("unlockWithRecoveryKey returns true on 200", async () => {
    mock.on("POST", "/api/unlock", {}, 200);
    const result = await unlockWithRecoveryKey("recovery-key-123");
    expect(result).toBeTruthy();
  });

  it("unlockWithRecoveryKey returns false on 403", async () => {
    mock.on("POST", "/api/unlock", {}, 403);
    const result = await unlockWithRecoveryKey("bad-key");
    expect(result).toBeFalsy();
  });

  it("unlockWithPrf returns true on 200", async () => {
    mock.on("POST", "/api/unlock", {}, 200);
    const result = await unlockWithPrf("prf-key-b64");
    expect(result).toBeTruthy();
  });

  it("lockApp calls fetch", async () => {
    mock.on("GET", "/api/lock", {});
    await lockApp(); // should not throw
  });

  it("registerPrf returns true on 200", async () => {
    mock.on("POST", "/api/prf/register", {}, 200);
    const result = await registerPrf("cred-id", "prf-key-b64", "My Key");
    expect(result).toBeTruthy();
  });

  it("removePrf returns true on 200", async () => {
    mock.on("POST", "/api/prf/remove", {}, 200);
    const result = await removePrf("cred-id");
    expect(result).toBeTruthy();
  });

  it("getStatus returns status object", async () => {
    mock.on("GET", "/api/status", {
      locked: false,
      encrypted: true,
      needs_setup: false,
      prf_credential_ids: ["cred1"],
      prf_credential_names: ["Key 1"],
    });
    const status = await getStatus();
    expect(status.encrypted).toBeTruthy();
    expect(status.locked).toBeFalsy();
    expect(status.prf_credential_ids).toHaveLength(1);
  });

  it("pinFile succeeds on 200", async () => {
    mock.on("POST", "/api/pin", {});
    await expect(pinFile("notes/a.md")).resolves.toBeUndefined();
  });

  it("unpinFile succeeds on 200", async () => {
    mock.on("DELETE", "/api/pin", {});
    await expect(unpinFile("notes/a.md")).resolves.toBeUndefined();
  });

  it("unpinFile throws on non-200", async () => {
    mock.on("DELETE", "/api/pin", { error: "fail" }, 500);
    await expect(unpinFile("notes/a.md")).rejects.toThrow("unpin failed");
  });
});
