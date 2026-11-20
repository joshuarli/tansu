# Deslop diagnose

Bounded review of Tansu's riskiest boundaries at base `8a20a7b` (branch `deslop/ground`), run on 2026-11-20. A
finding is filed only when it was reproduced against the built product with local fixtures and no external network.
Tickets live in `TODO-DESLOP.md`; this page holds the evidence.

## Method

- Product: `target/debug/tansu` with the embedded `web/dist` build, served on loopback ports against scratch vaults
  under `.work/tmp/`. Browser evidence uses Playwright Chromium against that server.
- Fixture vaults: a 3,000-note vault with symlinks and `z-images/`, one with unreadable entries, and one configured
  with `--auth https://notes.test notes.test Tansu`.
- Times come from a debug build on a busy macOS host. Compare the scaling between sizes, not the absolute numbers.

## Findings

| ID | Priority | Boundary | Defect |
| --- | --- | --- | --- |
| DSLP-25 | P2 | indexing, resource bounds | One 300 MB note disables search for the whole vault |
| DSLP-26 | P2 | HTTP and auth | Unauthenticated `login/options` fills the 256-ceremony cap and locks the owner out |
| DSLP-27 | P2 | extension messaging | Import image rewrite is quadratic on hostile Markdown and freezes the Tansu tab |
| DSLP-28 | P3 | HTTP, note save | Delta edits apply in quadratic time before the hash check |
| DSLP-29 | P3 | file handling | One unreadable file or folder makes the whole vault unavailable |
| DSLP-30 | P3 | HTTP transport | Idle half-open connections hold all 64 slots for up to 600 s |
| DSLP-31 | P3 | Loupe | The image scanner is quadratic on hostile page Markdown |

### F1 (DSLP-25) Oversize note

1. Vault of 3,000 notes: `POST .../search` for `needle` returned in 0.03 s.
2. Add one 300,000,000-byte `big.md`. The server reached 1.3 GB RSS and 52 CPU-seconds, searches for terms in it took
   about 30 s, and `bootstrap.searchStatus` read `{dirty:true, degraded:true}` after a restart.
3. Remove the search directory and restart: `needle`, `Alpha` and `Note 5` returned 200 with zero hits.
4. Delete `big.md` and restart: search returned hits again.

Cause: `walk_dir` reads whole files, and `check_rebuild_bounds` refuses the rebuild above 128 MiB of source or 10,000
notes. The 10,000-note bound shares the check and was not run separately.

### F2 (DSLP-26) Login ceremony lockout

With one credential row inserted into `auth.db` (a real passkey needs an authenticator), 300 requests to
`POST /api/v2/auth/login/options` with `Host: notes.test` and `Origin: https://notes.test`, no cookie, returned 255 x
200 then 45 x 429. The next call returned `rate_limited` with `retryAfterMs: 1000`. The store test
`authentication_ceremonies_are_pruned_and_bounded` asserts the same cap.

### F3 (DSLP-27) Import rewrite

Playwright posted `import.request` through `window.postMessage` to the served app, with the Markdown inside a code
fence. Time to `import.result`: 40 KB 0.8 s, 80 KB 3.0 s, 160 KB 12.7 s. Importing `rewriteImageTokens` in node
gave 0.9, 3.6 and 14.5 s. The receiver's 5 MB cap does not bound the work.

### F4 (DSLP-28) Delta save

A 2,000,000-line note and `PATCH .../notes/:id` with N single-line edits near the end, using a wrong `sourceHash`:
N=250 22.7 s, N=500 46.3 s, N=1000 89.6 s, each `400 source_hash_mismatch`. Linear in N with a document-sized
constant per edit.

### F5 (DSLP-29) Unreadable entries

A vault holding `good.md` and a mode-000 `bad.md`, and another holding `good.md` and a mode-000 folder: both answered
bootstrap with `error: "Permission denied (os error 13)"` and `503 vault_unavailable` on vault routes.

### F6 (DSLP-30) Idle connections

64 TCP connections that sent `GET /api/v2/health` and part of the headers, then stayed open. Every later health request
returned 503 at once and 30 s later.

### F7 (DSLP-31) Loupe scanner

`findLoupeImageOccurrences` on `![a](` repeated 20,000 times (100 KB) took 2.7 s, and 40,000 times (200 KB) took 10.9
s. Run from the module source in node, not from a packaged extension.

## Checked, no defect found

- Note and asset paths: `..`, absolute and `.tansu` names are rejected; reads and writes use `openat` with
  `O_NOFOLLOW` per component. A symlinked note and a symlinked folder in the vault were not listed or readable.
- Search queries: ten shapes at the 1,024-byte cap (wildcards, regex-like, nested brackets, 500 single terms, phrases)
  in both modes finished in under 0.2 s on 3,000 notes. Overlays are capped at 20 notes and 2 MB.
- Request bounds: header size and count, body size and a 10 s body deadline, a 64-connection cap, an 8-request
  blocking pool, bounded SSE replay and logs. Static assets come from an embedded manifest and reject `%` and `\`.
- Auth cookies, origin and CSRF checks follow `docs/security.md` as read; the import receiver accepts only same-window,
  same-origin messages. Uploaded images are served as `image/webp` with `nosniff`.
- Loupe's service worker fetches page-supplied image URLs from any host (`<all_urls>`). Chrome pages can already issue
  blind GETs, and the response is only stored in the user's own note, so it is not filed.

## Not reviewed

- WebAuthn verification internals (`crates/tansu-webauthn`): no authenticator or CBOR tooling here to build a valid
  attestation, so login finish and enrollment finish were not driven.
- Real passkey enrollment, session expiry and SSE revocation under auth.
- Concurrent writer races on the vault (external editors), rename and restore flows, history and conflict-draft growth.
- Editor behavior, the WebP encoder, and the browser extension's content script, options page and permissions in a
  packaged extension; Loupe findings come from module-level runs.
- Deployment, containers, and `scripts/`; Linux builds (only the macOS debug build ran).
