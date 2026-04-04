const q = process.argv[2];
if (!q) { console.error('usage: bun run web/ts/search-cli.ts <query>'); process.exit(1); }

const port = process.argv[3] ?? '3000';
const res = await fetch(`http://127.0.0.1:${port}/api/search?q=${encodeURIComponent(q)}`);
if (!res.ok) { console.error(`${res.status} ${res.statusText}`); process.exit(1); }

const results = await res.json() as { path: string; title: string; excerpt: string; score: number }[];
if (results.length === 0) { console.log('No results'); process.exit(0); }

for (const r of results) {
  const excerpt = r.excerpt.replace(/<b>/g, '\x1b[33m').replace(/<\/b>/g, '\x1b[0m').replace(/\n/g, ' ');
  console.log(`\x1b[1m${r.title}\x1b[0m  \x1b[2m${r.path}\x1b[0m  score=${r.score.toFixed(2)}`);
  if (excerpt) console.log(`  ${excerpt}`);
}
