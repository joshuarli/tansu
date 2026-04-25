import { SEARCH_CLI_DEFAULT_PORT, SEARCH_SCORE_PRECISION } from "./constants.ts";

const [q] = process.argv.slice(2);
if (!q) {
  console.error("usage: node web/ts/search-cli.ts <query>");
  process.exit(1);
}

const port = process.argv[3] ?? SEARCH_CLI_DEFAULT_PORT;
const res = await fetch(`http://127.0.0.1:${port}/api/search?q=${encodeURIComponent(q)}`);
if (!res.ok) {
  console.error(`${res.status} ${res.statusText}`);
  process.exit(1);
}

type FieldScores = {
  title: number;
  headings: number;
  tags: number;
  content: number;
};
type Result = {
  path: string;
  title: string;
  excerpt: string;
  score: number;
  field_scores: FieldScores;
};

const results = (await res.json()) as Result[];
if (results.length === 0) {
  console.log("No results");
  process.exit(0);
}

for (const r of results) {
  const excerpt = r.excerpt
    .replaceAll("<b>", "\u001B[33m")
    .replaceAll("</b>", "\u001B[0m")
    .replaceAll("\n", " ");
  const fs = r.field_scores;
  const parts: string[] = [];
  if (fs.title > 0) {
    parts.push(`title:${fs.title.toPrecision(SEARCH_SCORE_PRECISION)}`);
  }
  if (fs.headings > 0) {
    parts.push(`hdg:${fs.headings.toPrecision(SEARCH_SCORE_PRECISION)}`);
  }
  if (fs.tags > 0) {
    parts.push(`tags:${fs.tags.toPrecision(SEARCH_SCORE_PRECISION)}`);
  }
  if (fs.content > 0) {
    parts.push(`content:${fs.content.toPrecision(SEARCH_SCORE_PRECISION)}`);
  }
  const breakdown = parts.length > 0 ? `  \u001B[2m[${parts.join(" ")}]\u001B[0m` : "";
  console.log(
    `\u001B[1m${r.title}\u001B[0m  \u001B[2m${r.path}\u001B[0m  score=${r.score.toPrecision(SEARCH_SCORE_PRECISION)}${breakdown}`,
  );
  if (excerpt) {
    console.log(`  ${excerpt}`);
  }
}
