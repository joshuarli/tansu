import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const webTsDir = join(repoRoot, "web/ts");
const packageSrcDir = join(repoRoot, "packages/md-wysiwyg/src");
const packageEntry = join(packageSrcDir, "index.ts");

function walkSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry !== "e2e") {
        files.push(...walkSourceFiles(path));
      }
      continue;
    }
    if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".d.ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx")
    ) {
      files.push(path);
    }
  }
  return files.toSorted();
}

function importSpecs(src: string): string[] {
  const specs: string[] = [];
  const pattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of src.matchAll(pattern)) {
    const spec = match[1];
    if (spec) {
      specs.push(spec);
    }
  }
  return specs;
}

function resolveSourceImport(
  fromFile: string,
  spec: string,
  sourceSet: Set<string>,
): string | null {
  if (spec === "@joshuarli98/md-wysiwyg") {
    return packageEntry;
  }
  if (!spec.startsWith(".")) {
    return null;
  }

  const base = resolve(dirname(fromFile), spec.replace(/\.(ts|tsx|js|jsx)$/, ""));
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (sourceSet.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function buildGraph(files: string[]): Map<string, string[]> {
  const sourceSet = new Set(files);
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const deps = importSpecs(content)
      .map((spec) => resolveSourceImport(file, spec, sourceSet))
      .filter((dep): dep is string => dep !== null);
    graph.set(file, deps);
  }
  return graph;
}

function findCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];

  function visit(file: string): void {
    seen.add(file);
    active.add(file);
    stack.push(file);

    for (const dep of graph.get(file) ?? []) {
      if (!seen.has(dep)) {
        visit(dep);
      } else if (active.has(dep)) {
        const index = stack.indexOf(dep);
        cycles.push([...stack.slice(index), dep]);
      }
    }

    stack.pop();
    active.delete(file);
  }

  for (const file of graph.keys()) {
    if (!seen.has(file)) {
      visit(file);
    }
  }

  return cycles;
}

function rel(path: string): string {
  return relative(repoRoot, path);
}

describe("architecture boundaries", () => {
  it("md-wysiwyg package does not import app code", () => {
    const packageFiles = walkSourceFiles(packageSrcDir);
    const allSourceFiles = [...packageFiles, ...walkSourceFiles(webTsDir)];
    const sourceSet = new Set(allSourceFiles);
    const violations: string[] = [];

    for (const file of packageFiles) {
      const content = readFileSync(file, "utf8");
      for (const spec of importSpecs(content)) {
        const dep = resolveSourceImport(file, spec, sourceSet);
        if (dep?.startsWith(webTsDir)) {
          violations.push(`${rel(file)} -> ${rel(dep)}`);
        }
      }
    }

    expect(violations).toStrictEqual([]);
  });

  it("production frontend and editor package imports are acyclic", () => {
    const files = [...walkSourceFiles(packageSrcDir), ...walkSourceFiles(webTsDir)];
    const graph = buildGraph(files);
    const cycles = findCycles(graph).map((cycle) => cycle.map(rel).join(" -> "));

    expect(cycles).toStrictEqual([]);
  });

  it("server store receives UI callbacks through app runtime wiring", () => {
    const content = readFileSync(join(webTsDir, "server-store.ts"), "utf8");

    expect(importSpecs(content)).not.toContain("./ui-store.ts");
  });
});
