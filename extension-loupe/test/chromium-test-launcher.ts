import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export const CHROMIUM_BINARY_PATH = "/Applications/Chromium.app/Contents/MacOS/Chromium";

export function chromiumTestAvailable(): boolean {
  return existsSync(CHROMIUM_BINARY_PATH);
}

// Chromium emits the dump before exiting when these persistent-browser flags are enabled.
// Accept its successful output after the bounded process timeout so the test cannot hang.
export function runChromiumDumpDom(testPagePath: string, chromiumProfileDirectory: string): string {
  try {
    return execFileSync(
      CHROMIUM_BINARY_PATH,
      [
        "--headless=new",
        "--disable-gpu",
        "--virtual-time-budget=1000",
        "--window-size=1680,1050",
        `--user-data-dir=${chromiumProfileDirectory}`,
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--use-mock-keychain",
        "--disable-features=Translate,DialMediaRouteProvider,MediaRouter,OptimizationHints,GlobalMediaControls,PaintHolding,AvoidUnnecessaryBeforeUnloadCheckSync,ExtensionManifestV2Disabled",
        "--allow-running-insecure-content",
        "--disable-hang-monitor",
        "--disable-prompt-on-repost",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-infobars",
        "--disable-field-trial-config",
        "--disable-client-side-phishing-detection",
        "--disable-default-apps",
        "--disable-breakpad",
        "--disable-sync",
        "--force-webrtc-ip-handling-policy=default_public_interface_only",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--disable-component-extensions-with-background-pages",
        "--disable-component-update",
        "--disable-extensions",
        "--dump-dom",
        `file://${testPagePath}`,
      ],
      { encoding: "utf8", timeout: 3000 },
    );
  } catch (error) {
    const launchErrorDetails = error as { code?: string; stdout?: string };
    if (launchErrorDetails.code === "ETIMEDOUT" && launchErrorDetails.stdout) {
      return launchErrorDetails.stdout;
    }
    throw error;
  }
}
