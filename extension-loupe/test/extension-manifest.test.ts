import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";

test("extension manifest declares the Loupe MV3 runtime", () => {
  const extensionManifest = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../src/manifest.json"), "utf8"),
  ) as {
    name: string;
    manifest_version: number;
    minimum_chrome_version: string;
    permissions: string[];
    host_permissions: string[];
    optional_host_permissions?: string[];
    options_ui: { page: string; open_in_tab: boolean };
    commands: Record<string, { suggested_key: Record<string, string>; description: string }>;
    background: { service_worker: string };
    icons: Record<string, string>;
    content_security_policy: { extension_pages: string };
  };

  assert.equal(extensionManifest.name, "Loupe");
  assert.equal(extensionManifest.manifest_version, 3);
  assert.equal(extensionManifest.minimum_chrome_version, "150");
  assert.deepEqual(extensionManifest.permissions, [
    "activeTab",
    "scripting",
    "clipboardWrite",
    "downloads",
    "storage",
  ]);
  assert.deepEqual(extensionManifest.host_permissions, ["<all_urls>"]);
  assert.equal(extensionManifest.optional_host_permissions, undefined);
  assert.deepEqual(extensionManifest.options_ui, { page: "options.html", open_in_tab: true });
  assert.deepEqual(extensionManifest.commands["send-to-tansu"]?.suggested_key, {
    default: "Ctrl+Shift+S",
    mac: "Command+Shift+S",
  });
  assert.equal(extensionManifest.background.service_worker, "service-worker.js");
  assert.deepEqual(extensionManifest.icons, {
    "16": "loupe-extension-icon.svg",
    "48": "loupe-extension-icon.svg",
    "128": "loupe-extension-icon.svg",
  });
  assert.match(extensionManifest.content_security_policy.extension_pages, /wasm-unsafe-eval/u);
});
