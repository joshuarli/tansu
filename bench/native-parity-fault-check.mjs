import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cases = [
  { fault: "translation", scene: "chrome-900x640", evidence: "sidebar.x" },
  { fault: "wrong-width", scene: "empty-900x640", evidence: "Capture dimensions" },
  { fault: "font-size", scene: "tabs-markdown-1040x720", evidence: "fail" },
  { fault: "modal-offset", scene: "command-palette-panel", evidence: "panel x" },
  { fault: "altered-image", scene: "search-results-900x640", evidence: "Fixture source hash changed" },
  { fault: "wrong-note-source", scene: "search-results-900x640", evidence: "Fixture source hash changed" },
];

for (const { fault, scene, evidence } of cases) {
  const runID = `fault-${Date.now()}-${fault}`;
  const result = spawnSync(process.execPath, [join(repositoryRoot, "bench/native-parity.mjs")], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      TANSU_VISUAL_PARITY_FAULT: fault,
      TANSU_VISUAL_PARITY_RUN_ID: runID,
      TANSU_VISUAL_PARITY_SCENES: scene,
    },
  });
  if (result.error !== undefined) throw result.error;
  const reportPath = join(repositoryRoot, ".work/tmp/visual-parity", runID, "report.json");
  let report;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch (error) {
    throw new Error(`Fault run ${fault} did not persist its report: ${result.stderr}`, { cause: error });
  }
  const sceneReport = report.scenes.find((item) => item.sceneID === scene);
  if (result.status !== 1 || sceneReport?.status !== "fail") {
    throw new Error(`Fault run ${fault} did not produce the expected red result: ${result.stdout}\n${result.stderr}`);
  }
  const observed = [sceneReport.failure, ...sceneReport.geometryErrors, ...sceneReport.comparisons.map((item) => item.status)].filter(Boolean).join(" ");
  if (!observed.includes(evidence)) {
    throw new Error(`Fault run ${fault} failed for an unexpected reason: ${observed}`);
  }
  process.stdout.write(`DETECTED ${fault}: ${sceneReport.failure || sceneReport.geometryErrors.join("; ") || observed}\n`);
}
