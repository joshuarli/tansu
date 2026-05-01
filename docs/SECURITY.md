# Tansu Encryption Design

## Threat Model

Self-hosted on an untrusted VPS, accessed via Tailscale. Threats:

- Cloud provider or attacker reads disk contents
- VPS disk image copied/leaked

Non-threats (out of scope):

- Compromised running server process (at-rest model; server holds key in memory)
- Network interception (Tailscale WireGuard tunnel)
- Client-side attacks (user's own device)

Filename/path leakage is an accepted risk — note titles and directory structure are visible on disk, only content is encrypted.

## Modes of Operation

**Plaintext mode** (default): No `.tansu/crypto.json` exists. Server starts normally, no unlock required. Current behavior, for local use.

**Encrypted mode**: `.tansu/crypto.json` exists (created by `tansu encrypt`). Server starts in locked state, requires unlock before any content is accessible.

## Key Hierarchy

```
recovery key (128-bit random) ──→ HKDF-SHA256 ──→ KEK_recovery ──→ ┐
                                                                     ├──→ unwraps MASTER_KEY
WebAuthn PRF output ──→ HKDF-SHA256 ──→ KEK_prf ──────────────────┘
                                                    (one per credential)

MASTER_KEY ──→ encrypts all files on disk
```

- **MASTER_KEY**: Random 256-bit key, generated once by `tansu encrypt`.
- **Recovery key**: 128-bit random, generated at setup, displayed once as hex groups (`A94F-B127-E3D0-8C5A-7F21-9D6B-43E8-0A5C`). Stored by user in a password manager. Full entropy, no key stretching needed — KEK derived via HKDF-SHA256 (salt="tansu-recovery-kek").
- **KEK_prf**: Derived from WebAuthn PRF output via HKDF-SHA256 (salt="tansu-prf-kek"). One per registered credential. Primary daily unlock method (Face ID / Touch ID).
- Each KEK independently wraps (AES-256-GCM) the master key. All wrapped blobs stored in `crypto.json`.

If the recovery key and all PRF credentials are lost, data is unrecoverable. This is by design.

## Encrypted File Format

Every encrypted file on disk:

```
[4-byte magic: 0x54 0x4E 0x53 0x01] [12-byte nonce] [ciphertext + 16-byte GCM tag]
```

Magic bytes `TNS\x01` (version 1) distinguish encrypted from plaintext files. This makes `tansu encrypt` and `tansu decrypt` idempotent and crash-safe — partially migrated directories can be re-run safely.

AES-256-GCM, random 12-byte nonce per write. Birthday bound for nonce collision is ~2^48 encryptions — not a concern for a notes app.

## What Gets Encrypted

| Data                   | Encrypted      | Notes                                        |
| ---------------------- | -------------- | -------------------------------------------- |
| Note .md files         | Yes            |                                              |
| Revision .md files     | Yes            |                                              |
| Uploaded images        | Yes            |                                              |
| `.tansu/settings.json` | No             | No sensitive content (font size, theme)      |
| `.tansu/state.json`    | No             | Tab paths only, acceptable                   |
| `.tansu/crypto.json`   | No             | Contains wrapped keys, not plaintext secrets |
| Tantivy search index   | In-memory only | `RamDirectory`, rebuilt on unlock            |

## Session Management

Vault selection is tab-scoped. Each browser tab keeps its selected vault index in `sessionStorage`, and every request sends it explicitly:

```
X-Tansu-Vault: <index>
GET /events?vault=<index>
```

Encrypted auth is also vault-scoped. On unlock, server generates a random 256-bit session token for that vault and returns:

```
Set-Cookie: tansu_session_<vault-index>=<hex>; HttpOnly; SameSite=Strict; Path=/
```

No `Secure` flag (Tailscale, not TLS). Each encrypted-vault API request resolves the vault from `X-Tansu-Vault`, then checks the matching `tansu_session_<index>` cookie. Missing or wrong token returns 403.

**Idle timeout**: Server tracks the timestamp of the last authenticated API request. SSE connections do not count as activity — only real user actions (save, load, search, etc.) reset the timer. After **24 hours of inactivity**, the server re-locks:

1. Zeroize master key
2. Drop tantivy `RamDirectory` index
3. Clear all session tokens for that vault
4. Send `event: locked` on SSE connections for that vault, then close them
5. Next request to any route gets 403 (API) or the unlock page (HTML)

The timeout is checked lazily on each incoming API request.

`GET /api/lock` triggers the same re-lock sequence immediately.

**Client-side re-lock handling**: `server-store.ts` watches for the `locked` SSE event. On receipt, it closes the EventSource, marks the connection locked, and asks the boot controller to show the unlock screen. No page reload is needed. On re-unlock, UI restores from `state.json`.

## Server Lifecycle

```
             no crypto.json                  crypto.json exists
START ──────────────────────→ PLAINTEXT     START ──→ LOCKED
                              (current                  │
                               behavior)    (unlock via recovery key or PRF)
                                                        ↓
                                                    UNLOCKED → RUNNING
                                                        ↑          │
                                                        └──────────┘
                                                    (24h idle or /api/lock)
```

**Locked state**: Server serves only:

- `GET /` → unlock page (biometric button + recovery key fallback)
- `POST /api/unlock` → accepts recovery key or PRF-derived key
- `GET /api/status` → `{ locked, needs_setup, prf_credential_ids, prf_credential_names }`
- Static assets (`app.js`, `app.css`)
- All other routes return 403

**Unlock flow**:

1. Decrypt master key into memory
2. Set the per-vault session cookie
3. Return 200 immediately (client transitions to app)
4. Background: rebuild tantivy index (decrypt + index all notes)
5. Search returns empty results until index rebuild completes; client shows "Rebuilding search index..." on search attempts during this window

## Persisted Crypto State

`.tansu/crypto.json`:

```json
{
  "version": 1,
  "master_key_recovery": {
    "nonce": "<base64>",
    "ciphertext": "<base64>"
  },
  "prf_credentials": [
    {
      "id": "<base64url>",
      "name": "MacBook Touch ID",
      "created": "2026-04-04T12:00:00Z",
      "nonce": "<base64>",
      "ciphertext": "<base64>"
    },
    {
      "id": "<base64url>",
      "name": "iPhone Face ID",
      "created": "2026-04-05T09:00:00Z",
      "nonce": "<base64>",
      "ciphertext": "<base64>"
    }
  ]
}
```

`prf_credentials` is an empty array until credentials are registered. Each entry independently wraps the master key with its own KEK. No server-side WebAuthn assertion verification — the PRF output is self-authenticating (correct output unwraps the key; wrong output fails GCM auth tag check).

## WebAuthn + PRF Flow

No server-side assertion verification needed. The PRF-derived key is self-authenticating: correct PRF output → GCM unwrap succeeds; wrong output → GCM auth fails. This eliminates any WebAuthn server library dependency.

### Registration (requires active session)

Browser:

```js
const prfSalt = new Uint8Array(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode("tansu-prf-salt-v1")),
);

const credential = await navigator.credentials.create({
  publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { name: "Tansu", id: location.hostname },
    user: { id: new Uint8Array([1]), name: "owner", displayName: "Owner" },
    pubKeyCredParams: [{ alg: -7, type: "public-key" }],
    authenticatorSelection: { userVerification: "required" },
    extensions: {
      prf: { eval: { first: prfSalt } },
    },
  },
});

const prfResult = credential.getClientExtensionResults().prf;
if (!prfResult?.results?.first) throw new Error("PRF not supported");

const name = prompt("Name this credential (e.g. 'MacBook Touch ID')");
// POST /api/prf/register { credential_id, prf_key, name }
```

Server: derive KEK_prf = HKDF-SHA256(prfOutput, salt="tansu-prf-kek"), wrap master key, append to `prf_credentials` array in `crypto.json`.

### Authentication (unlock)

Browser:

```js
// credential IDs from GET /api/status → prf_credential_ids
const allowCredentials = credentialIds.map((id) => ({
  type: "public-key",
  id: base64urlToBuffer(id),
}));

const assertion = await navigator.credentials.get({
  publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rpId: location.hostname,
    allowCredentials,
    userVerification: "required",
    extensions: {
      prf: { eval: { first: prfSalt } },
    },
  },
});

const prfOutput = assertion.getClientExtensionResults().prf.results.first;
// POST /api/unlock { prf_key: base64(prfOutput) }
```

Server: try each `prf_credentials` entry — derive KEK, attempt GCM unwrap. First success → unlocked.

The PRF salt is a fixed app-level constant (SHA-256 of "tansu-prf-salt-v1"), stored in the TS source. Not secret — it provides domain separation so the same authenticator produces different outputs for different apps.

## API Endpoints (New)

```
GET  /api/status         → { locked, needs_setup, prf_credential_ids, prf_credential_names }
POST /api/unlock         { recovery_key: "<hex>" }           → unlock with recovery key
                         { prf_key: "<base64>" }             → unlock with PRF output
POST /api/prf/register   { credential_id, prf_key, name }   → add PRF credential (requires session)
POST /api/prf/remove     { credential_id }                   → remove PRF credential (requires session)
GET  /api/lock                                               → zeroize key, clear session, close SSE
```

All endpoints for a locked encrypted vault reject requests except `/api/status`, `/api/unlock`, `/api/vaults`, and `POST /api/vaults/*/activate`. Unlocked encrypted-vault endpoints require both an explicit vault selection (`X-Tansu-Vault` or `/events?vault=`) and the matching per-vault session cookie. `POST /api/setup` is not an API endpoint — setup is handled by `tansu encrypt` on the CLI.

## Encryption Layer (Rust)

New module `src/crypto.rs`:

```rust
const MAGIC: &[u8; 4] = b"TNS\x01";

pub struct Vault {
    key: [u8; 32],  // MASTER_KEY, zeroized on Drop
}

impl Vault {
    /// Encrypt plaintext → magic || nonce || ciphertext || tag
    pub fn encrypt(&self, plaintext: &[u8]) -> Vec<u8>;

    /// Decrypt: verify magic, then AES-256-GCM decrypt. Err if not encrypted or tampered.
    pub fn decrypt(&self, blob: &[u8]) -> Result<Vec<u8>>;

    /// Read file, decrypt, return as String. Err if file missing or decryption fails.
    pub fn read_to_string(&self, path: &Path) -> Result<String>;

    /// Encrypt data, atomic write (write to .tmp, rename).
    pub fn write(&self, path: &Path, data: &[u8]) -> Result<()>;

    /// Read file, decrypt, return raw bytes. For images.
    pub fn read(&self, path: &Path) -> Result<Vec<u8>>;
}

impl Drop for Vault {
    fn drop(&mut self) { self.key.zeroize(); }
}

/// Key wrapping: encrypt/decrypt the master key with a KEK
pub fn wrap_key(master: &[u8; 32], kek: &[u8; 32]) -> (Nonce, Vec<u8>);
pub fn unwrap_key(nonce: &Nonce, ciphertext: &[u8], kek: &[u8; 32]) -> Result<[u8; 32]>;

/// KEK derivation
pub fn kek_from_recovery_key(recovery_key: &[u8; 16]) -> [u8; 32];  // HKDF-SHA256
pub fn kek_from_prf(prf_output: &[u8]) -> [u8; 32];                 // HKDF-SHA256

/// crypto.json persistence
pub fn load_crypto_config(dir: &Path) -> Result<CryptoConfig>;
pub fn save_crypto_config(dir: &Path, config: &CryptoConfig) -> Result<()>;
```

Each `VaultState` holds `Option<Vault>` + `Vec<SessionState>`:

- `vault = None` = locked (or plaintext mode if no `crypto.json`)
- `vault = Some(...)` = unlocked
- `sessions` holds active client sessions for that vault

```rust
struct SessionState {
    token: [u8; 32],
    last_activity: Instant,
}
```

In plaintext mode, `Server` holds no `Vault` and no `SessionState` — all routes are open, file I/O uses `fs` directly (current behavior).

Session check: on every non-SSE request, resolve the vault from `X-Tansu-Vault`, compare against that vault's `tansu_session_<index>` cookies, and update the matching `last_activity`.

## CLI Commands

### `tansu encrypt`

Offline tool (server must not be running). Generates master key and recovery key, prompts user to save the recovery key, writes `crypto.json`, then walks the notes directory encrypting all files in place.

```
$ tansu encrypt
Generated recovery key (save this — it cannot be shown again):

  A94F-B127-E3D0-8C5A-7F21-9D6B-43E8-0A5C

Press Enter to continue after saving...
Encrypting... 142/142 files
Done. Server will now require unlock on startup.
```

- Skips files that already have `TNS\x01` magic (idempotent, crash-safe)
- Skips `.tansu/settings.json`, `.tansu/state.json`, `.tansu/crypto.json`
- Skips `.tansu/index/` directory entirely (will be rebuilt by server)
- Processes: `**/*.md`, `z-images/*`, `.tansu/revisions/**/*.md`

### `tansu decrypt`

Offline tool (server must not be running). Prompts for recovery key, derives KEK, unwraps master key, then walks the notes directory decrypting all files in place.

```
$ tansu decrypt
Recovery key: A94F-B127-E3D0-8C5A-7F21-9D6B-43E8-0A5C
Decrypting... 142/142 files
Removed crypto.json. Server will now start in plaintext mode.
```

- Skips files that lack `TNS\x01` magic (idempotent, crash-safe)
- Same file selection as `tansu encrypt`
- Deletes `crypto.json` after all files are successfully decrypted
- Returns to plaintext mode

Both commands operate on the current directory (or `--dir <path>`). They share `crypto.rs` with the server binary (same binary, subcommands).

## Browser-Side Changes

### Unlock page (`web/ts/unlock.ts`)

Rendered when `GET /api/status` returns `locked: true`. Two unlock paths:

1. **Biometric (primary)**: If `prf_credential_ids` is non-empty, show "Unlock with Face ID / Touch ID" button prominently. Triggers WebAuthn `get()` with PRF extension. Sends PRF output to `POST /api/unlock`.
2. **Recovery key (fallback)**: Collapsible "Use recovery key" section with text input. Sends to `POST /api/unlock`.

On success (200 + session cookie set), transitions to main app UI.

### PRF management

In settings panel: list registered credentials (name + created date), buttons to register new or remove existing. Registration requires the current session. After first PRF registration, subsequent unlocks default to biometric.

### Re-lock handling

The SSE listener in `server-store.ts` handles `event: locked`:

1. Close the current EventSource
2. Mark the server connection as locked
3. Show the unlock screen through the boot controller
4. On re-unlock, restore UI from `state.json`

## Rust Dependencies

| Crate           | Purpose                                                                       |
| --------------- | ----------------------------------------------------------------------------- |
| `aes-gcm`       | AES-256-GCM encryption (RustCrypto, pure Rust)                                |
| `hkdf` + `sha2` | KEK derivation for both recovery key and PRF (RustCrypto, pure Rust)          |
| `zeroize`       | Secure memory clearing for keys                                               |
| `rand`          | Already a dependency; used for nonce, master key, recovery key, session token |
| `base64`        | Encoding for crypto.json (already a dependency via tantivy)                   |

No `argon2` — recovery key has full entropy, HKDF is sufficient.
No WebAuthn server library — PRF output is self-authenticating.

## Implementation Progress

### Step 1: `crypto.rs`

- [x] Vault struct with encrypt/decrypt (magic header + AES-256-GCM)
- [x] Vault file I/O: `read_to_string`, `read`, `write` (atomic)
- [x] Key wrapping: `wrap_key` / `unwrap_key`
- [x] KEK derivation: `kek_from_recovery_key`, `kek_from_prf`
- [x] `CryptoConfig` serde + persist/load `crypto.json`
- [x] Recovery key generation + hex-group formatting
- [x] Tests for all of the above (17 tests)

### Step 2: CLI subcommands

- [x] Subcommand dispatch (`tansu encrypt`, `tansu decrypt`, or start server)
- [x] `tansu encrypt`: generate keys, display recovery key, walk + encrypt files
- [x] `tansu decrypt`: prompt recovery key, walk + decrypt files, remove crypto.json
- [x] Idempotency: skip already-encrypted/decrypted files via magic header
- [x] Tests for encrypt/decrypt round-trip on a temp directory (18 tests total)

### Step 3: Server lock/unlock lifecycle

- [x] `Option<Vault>` + `Option<SessionState>` in Server
- [x] Session cookie parsing + validation
- [x] 24h idle timeout (check on each request)
- [x] Locked-state routing (403 for non-unlock routes)
- [x] `POST /api/unlock` (recovery key + PRF key)
- [x] `GET /api/lock`, `GET /api/status`
- [x] Plaintext mode (no crypto.json = current behavior)
- [x] `POST /api/prf/register`, `POST /api/prf/remove`

### Step 4: Migrate file I/O

- [x] Replace `fs::read_to_string` / `atomic_write` / `fs::write` with vault methods
- [x] Vault-aware reindex on settings change + unlock
- [x] SSE `locked` event on re-lock
- [x] File watcher handles encrypted files (via `read_content` helper)
- [x] Encrypted image serving (decrypt + serve bytes with cache headers)

### Step 5: Unlock UI

- [x] Unlock screen: recovery key form, unlock flow, error handling
- [x] Re-lock SSE handler (`locked` event hides app, shows unlock)
- [x] Boot-time status check (`/api/status`) gates app init
- [x] Unlock status feedback ("Unlocking...", "Loading...")
- [ ] Setup flow (first visit after `tansu encrypt`) — deferred to WebAuthn step

### Step 6: WebAuthn PRF

- [x] `POST /api/prf/register`, `POST /api/prf/remove` (server — done in Step 3)
- [x] Browser WebAuthn registration + PRF extraction (`webauthn.ts`)
- [x] Face ID / Touch ID unlock flow (auto-trigger on unlock screen)
- [x] Credential management in settings panel (add/remove + lock button)
