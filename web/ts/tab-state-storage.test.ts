import "fake-indexeddb/auto";
import { closeStore, noteGet, openStore } from "./local-store.ts";
import { fetchNoteWithOfflineFallback } from "./tab-state-storage.ts";
import { setupDOM } from "./test-helper.ts";

describe("tab-state-storage", () => {
  let cleanup: () => void;
  let originalFetch: typeof fetch;

  beforeAll(async () => {
    cleanup = setupDOM();
    originalFetch = globalThis.fetch;
    await openStore();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    closeStore();
    cleanup();
  });

  it("captures the vault index at request start for cache writes", async () => {
    sessionStorage.setItem("tansu_vault", "0");

    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        setTimeout(() => {
          resolve(
            Response.json({
              content: "# Delayed",
              mtime: 4242,
              tags: [],
              title: "Delayed",
            }),
          );
        }, 10);
      })) as typeof fetch;

    const pending = fetchNoteWithOfflineFallback("race.md");
    sessionStorage.setItem("tansu_vault", "1");

    await expect(pending).resolves.toMatchObject({
      content: "# Delayed",
      mtime: 4242,
    });

    await expect(noteGet(0, "race.md")).resolves.toStrictEqual({
      content: "# Delayed",
      mtime: 4242,
      tags: [],
    });
    await expect(noteGet(1, "race.md")).resolves.toBeUndefined();
  });
});
