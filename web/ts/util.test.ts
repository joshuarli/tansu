import { assertEqual } from "./test-helper.ts";
import { escapeHtml, relativeTime, stemFromPath, debounce } from "./util.ts";

// escapeHtml
assertEqual(escapeHtml("&"), "&amp;", "escape ampersand");
assertEqual(escapeHtml("<"), "&lt;", "escape lt");
assertEqual(escapeHtml(">"), "&gt;", "escape gt");
assertEqual(escapeHtml('"'), "&quot;", "escape quote");
assertEqual(
  escapeHtml('<script>"&"</script>'),
  "&lt;script&gt;&quot;&amp;&quot;&lt;/script&gt;",
  "escape combined",
);
assertEqual(escapeHtml("hello"), "hello", "escape no-op");
assertEqual(escapeHtml(""), "", "escape empty");

// stemFromPath
assertEqual(stemFromPath("notes/hello.md"), "hello", "stem basic");
assertEqual(stemFromPath("hello.md"), "hello", "stem no dir");
assertEqual(stemFromPath("deep/nested/path/note.md"), "note", "stem deep");
assertEqual(stemFromPath("UPPER.MD"), "UPPER", "stem case insensitive extension");
assertEqual(stemFromPath("no-extension"), "no-extension", "stem no extension");
assertEqual(stemFromPath("dots.in.name.md"), "dots.in.name", "stem dots in name");

// relativeTime (deterministic with explicit `now`)
const now = 1_700_000_000_000;
assertEqual(relativeTime(now, now), "just now", "time just now");
assertEqual(relativeTime(now - 30_000, now), "just now", "time 30s ago");
assertEqual(relativeTime(now - 120_000, now), "2m ago", "time 2m ago");
assertEqual(relativeTime(now - 3600_000, now), "1h ago", "time 1h ago");
assertEqual(relativeTime(now - 7200_000, now), "2h ago", "time 2h ago");
assertEqual(relativeTime(now - 86400_000, now), "1d ago", "time 1d ago");
// >7 days returns locale date string — just check it's not "Xd ago"
const weekAgo = relativeTime(now - 700_000_000, now);
assertEqual(weekAgo.includes("d ago"), false, "time >7d uses date");
// Still works without explicit now (backwards compat)
assertEqual(typeof relativeTime(Date.now()), "string", "default now works");

// debounce
let callCount = 0;
const debounced = debounce(() => {
  callCount++;
}, 10);
debounced();
debounced();
debounced();
assertEqual(callCount, 0, "debounce not called yet");
await new Promise((r) => setTimeout(r, 50));
assertEqual(callCount, 1, "debounce called once");

console.log("All util tests passed");
