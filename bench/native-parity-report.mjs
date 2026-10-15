import { access, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const reportsRoot = join(repositoryRoot, ".work/tmp/visual-parity");
const requestedRunID = process.env.TANSU_VISUAL_PARITY_RUN_ID;
const entries = await readdir(reportsRoot, { withFileTypes: true });
const runIDs = requestedRunID === undefined || requestedRunID === ""
  ? entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse()
  : [requestedRunID];
let reportPath;

for (const runID of runIDs) {
  const candidate = join(reportsRoot, runID, "report.json");
  try {
    await access(candidate);
    reportPath = candidate;
    break;
  } catch {
    if (requestedRunID !== undefined && requestedRunID !== "") {
      throw new Error(`No visual parity report for run ${requestedRunID}`);
    }
  }
}

if (reportPath === undefined) throw new Error("No visual parity report exists; run make visual-parity first");

const report = JSON.parse(await readFile(reportPath, "utf8"));
const reportDirectory = join(repositoryRoot, ".work/tmp/visual-parity", report.runID);
process.stdout.write(`Visual parity ${report.runID} (${report.browser})\n`);
for (const scene of report.scenes) {
  process.stdout.write(`${scene.status.toUpperCase()} ${scene.sceneID}\n`);
  process.stdout.write(`  actual: ${scene.pixelWidth}×${scene.pixelHeight}px, SHA-256 ${scene.actualSHA256 ?? "missing"}\n`);
  for (const comparison of scene.comparisons) {
    const focus = comparison.focusRegions.map((region) => `${region.name} ${region.aa.changedPixelPercent}% AA`).join(", ");
    process.stdout.write(
      `  ${comparison.oracleKind}: ${comparison.status}, ${comparison.aa.fullFrame.changedPixelPercent}% AA, ${comparison.raw.fullFrame.changedPixelPercent}% raw${focus === "" ? "" : `; ${focus}`}\n`,
    );
  }
}
process.stdout.write(`Report: ${reportPath}\nGallery: ${join(reportDirectory, "index.html")}\n`);
