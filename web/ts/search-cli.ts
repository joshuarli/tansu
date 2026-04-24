export {};

const [q] = process.argv.slice(2);
if (!q) {
  console.error("usage: node web/ts/search-cli.ts <query>");
  process.exit(1);
}

const port = process.argv[3] ?? "3000";
const res = await fetch(`http://127.0.0.1:${port}/api/search?q=${encodeURIComponent(q)}`);
if (!res.ok) {
  console.error(`${res.status} ${res.statusText}`);
  process.exit(1);
}

interface FieldScores {
  title: number;
  headings: number;
  tags: number;
  content: number;
}
interface Result {
  path: string;
  title: string;
  excerpt: string;
  score: number;
  field_scores: FieldScores;
}

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
    parts.push(`title:${fs.title.toPrecision(3)}`);
  }
  if (fs.headings > 0) {
    parts.push(`hdg:${fs.headings.toPrecision(3)}`);
  }
  if (fs.tags > 0) {
    parts.push(`tags:${fs.tags.toPrecision(3)}`);
  }
  if (fs.content > 0) {
    parts.push(`content:${fs.content.toPrecision(3)}`);
  }
  const breakdown = parts.length > 0 ? `  \u001B[2m[${parts.join(" ")}]\u001B[0m` : "";
  console.log(
    `\u001B[1m${r.title}\u001B[0m  \u001B[2m${r.path}\u001B[0m  score=${r.score.toPrecision(3)}${breakdown}`,
  );
  if (excerpt) {
    console.log(`  ${excerpt}`);
  }
}
