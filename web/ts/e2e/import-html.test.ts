import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "playwright";

import { setup, teardown } from "./setup.ts";

describe("e2e: import html", () => {
  let page: Page;
  let notesDir: string;
  let baseUrl: string;

  beforeEach(async () => {
    const ctx = await setup();
    ({ page, notesDir, baseUrl } = ctx);
    await page.goto(baseUrl);
    await page.waitForSelector("#tab-bar", { timeout: 5000 });
  }, 30_000);

  afterEach(async () => {
    await teardown();
  });

  it("Cmd+I imports fixture html as markdown", async () => {
    const fixturePath = join(import.meta.dirname, "..", "fixtures", "import-article.html");
    const chooserPromise = page.waitForEvent("filechooser");
    await page.keyboard.press("Meta+i");

    const chooser = await chooserPromise;
    await chooser.setFiles(fixturePath);

    await page.waitForSelector(".tab.active", { timeout: 5000 });
    await page.waitForTimeout(500);
    const activeTitle = await page.$eval(
      ".tab.active .tab-label-text",
      (el) => el.textContent ?? "",
    );
    expect(activeTitle).toBe("import-article");

    const filePath = join(notesDir, "import-article.md");
    const content = readFileSync(filePath, "utf8");
    expect(content).toContain('title: "Fixture Import"');
    expect(content).toContain("Intro paragraph with **bold** text.");
    expect(content).toContain("First item");
    expect(content).toContain("Closing paragraph.");
    expect(content).not.toContain("<article");
    expect(content).not.toContain("<p>");
    expect(content).not.toContain("<h1>");
  }, 30_000);
});
