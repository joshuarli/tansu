use std::{
    fs,
    io,
    path::{Path, PathBuf},
};

use aes_gcm::{
    Aes256Gcm, Key, Nonce,
    aead::{Aead, KeyInit, OsRng},
};
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use hkdf::Hkdf;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::{ZeroizeOnDrop, Zeroizing};

const MAGIC: &[u8; 4] = b"TNS\x01";
const NONCE_LEN: usize = 12;
// HKDF salts (not secret, provide domain separation)
const RECOVERY_SALT: &[u8] = b"tansu-recovery-kek";
const PRF_SALT: &[u8] = b"tansu-prf-kek";

#[derive(ZeroizeOnDrop)]
pub struct Vault {
    key: [u8; 32],
}

impl Vault {
    pub fn new(key: Zeroizing<[u8; 32]>) -> Self {
        Vault { key: *key }
    }

    /// Create from a raw key array (for CLI commands where Zeroizing is awkward)
    pub fn from_raw(key: [u8; 32]) -> Self {
        Vault { key }
    }

    /// Wrap the master key with a KEK, without exposing the raw key.
    pub fn wrap_master_key(&self, kek: &[u8; 32]) -> WrappedKey {
        wrap_key(&self.key, kek)
    }

    /// Encrypt plaintext → magic || nonce || ciphertext+tag
    pub fn encrypt(&self, plaintext: &[u8]) -> Vec<u8> {
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&self.key));
        let mut nonce_bytes = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = cipher.encrypt(nonce, plaintext).expect("encryption failed");
        let mut out = Vec::with_capacity(MAGIC.len() + NONCE_LEN + ciphertext.len());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);
        out
    }

    /// Decrypt: verify magic, then AES-256-GCM decrypt.
    pub fn decrypt(&self, blob: &[u8]) -> io::Result<Vec<u8>> {
        let header_len = MAGIC.len() + NONCE_LEN;
        if blob.len() < header_len || &blob[..MAGIC.len()] != MAGIC {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "not an encrypted file"));
        }
        let nonce_bytes = &blob[MAGIC.len()..header_len];
        let ciphertext = &blob[header_len..];
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&self.key));
        let nonce = Nonce::from_slice(nonce_bytes);
        cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "decryption failed"))
    }

    /// Read + decrypt a file, return as String.
    pub fn read_to_string(&self, path: &Path) -> io::Result<String> {
        let blob = fs::read(path)?;
        let plaintext = self.decrypt(&blob)?;
        String::from_utf8(plaintext)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid UTF-8"))
    }

    /// Read + decrypt a file, return raw bytes (for images).
    pub fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        let blob = fs::read(path)?;
        self.decrypt(&blob)
    }

    /// Encrypt + atomic write a file.
    pub fn write(&self, path: &Path, data: &[u8]) -> io::Result<()> {
        let encrypted = self.encrypt(data);
        atomic_write(path, &encrypted)
    }

    /// Encrypt + atomic write, also registering in self_writes set (for watcher filtering).
    pub fn write_tracked(
        &self,
        path: &Path,
        data: &[u8],
        self_writes: &std::sync::Mutex<std::collections::HashSet<PathBuf>>,
    ) -> io::Result<()> {
        self_writes.lock().unwrap().insert(path.to_path_buf());
        self.write(path, data)
    }
}

/// Atomic write: write to .tmp then rename.
pub fn atomic_write(path: &Path, content: &[u8]) -> io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, content)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Returns true if the blob starts with the TNS magic header.
pub fn is_encrypted(blob: &[u8]) -> bool {
    blob.len() >= MAGIC.len() && &blob[..MAGIC.len()] == MAGIC
}

/// Wrap the master key with a KEK using AES-256-GCM.
pub fn wrap_key(master: &[u8; 32], kek: &[u8; 32]) -> WrappedKey {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(kek));
    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher.encrypt(nonce, master.as_slice()).expect("wrap failed");
    WrappedKey {
        nonce: nonce_bytes,
        ciphertext,
    }
}

/// Unwrap the master key with a KEK. Returns Err if the KEK is wrong.
pub fn unwrap_key(wrapped: &WrappedKey, kek: &[u8; 32]) -> io::Result<Zeroizing<[u8; 32]>> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(kek));
    let nonce = Nonce::from_slice(&wrapped.nonce);
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(nonce, wrapped.ciphertext.as_slice())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "wrong key"))?,
    );
    if plaintext.len() != 32 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid key length"));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&plaintext);
    Ok(Zeroizing::new(key))
}

/// Derive KEK from a 128-bit recovery key via HKDF-SHA256.
pub fn kek_from_recovery_key(recovery_key: &[u8; 16]) -> [u8; 32] {
    hkdf_derive(recovery_key, RECOVERY_SALT)
}

/// Derive KEK from a WebAuthn PRF output (32 bytes) via HKDF-SHA256.
pub fn kek_from_prf(prf_output: &[u8]) -> [u8; 32] {
    hkdf_derive(prf_output, PRF_SALT)
}

fn hkdf_derive(ikm: &[u8], salt: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut okm = [0u8; 32];
    hk.expand(b"tansu-kek-v1", &mut okm)
        .expect("HKDF expand failed");
    okm
}

/// Generate a random 128-bit recovery key.
pub fn generate_recovery_key() -> [u8; 16] {
    let mut key = [0u8; 16];
    OsRng.fill_bytes(&mut key);
    key
}

/// Format a 128-bit recovery key as hex groups: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
pub fn format_recovery_key(key: &[u8; 16]) -> String {
    let hex: String = key.iter().map(|b| format!("{b:02X}")).collect();
    hex.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join("-")
}

/// Parse a recovery key from hex-group format. Ignores dashes and whitespace.
pub fn parse_recovery_key(input: &str) -> io::Result<[u8; 16]> {
    let hex: String = input.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 32 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "recovery key must be 32 hex digits",
        ));
    }
    let mut key = [0u8; 16];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        key[i] = u8::from_str_radix(std::str::from_utf8(chunk).unwrap(), 16)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid hex"))?;
    }
    Ok(key)
}

/// Generate a random 256-bit master key.
pub fn generate_master_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    key
}

pub struct WrappedKey {
    pub nonce: [u8; NONCE_LEN],
    pub ciphertext: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
pub struct WrappedKeyJson {
    pub nonce: String,
    pub ciphertext: String,
}

impl From<&WrappedKey> for WrappedKeyJson {
    fn from(w: &WrappedKey) -> Self {
        WrappedKeyJson {
            nonce: B64.encode(w.nonce),
            ciphertext: B64.encode(&w.ciphertext),
        }
    }
}

impl WrappedKeyJson {
    pub fn to_wrapped_key(&self) -> io::Result<WrappedKey> {
        let nonce_vec = B64
            .decode(&self.nonce)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        if nonce_vec.len() != NONCE_LEN {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "bad nonce length"));
        }
        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(&nonce_vec);
        let ciphertext = B64
            .decode(&self.ciphertext)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        Ok(WrappedKey { nonce, ciphertext })
    }
}

#[derive(Serialize, Deserialize)]
pub struct PrfCredential {
    pub id: String,
    pub name: String,
    pub created: String,
    #[serde(flatten)]
    pub wrapped_key: WrappedKeyJson,
}

#[derive(Serialize, Deserialize)]
pub struct CryptoConfig {
    pub version: u32,
    pub master_key_recovery: WrappedKeyJson,
    #[serde(default)]
    pub prf_credentials: Vec<PrfCredential>,
}

impl CryptoConfig {
    pub fn load(dir: &Path) -> io::Result<Self> {
        let path = dir.join(".tansu/crypto.json");
        let data = fs::read_to_string(path)?;
        serde_json::from_str(&data)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    pub fn load_if_exists(dir: &Path) -> io::Result<Option<Self>> {
        let path = dir.join(".tansu/crypto.json");
        if !path.exists() {
            return Ok(None);
        }
        Self::load(dir).map(Some)
    }

    pub fn save(&self, dir: &Path) -> io::Result<()> {
        let path = dir.join(".tansu/crypto.json");
        fs::create_dir_all(path.parent().unwrap())?;
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
        atomic_write(&path, json.as_bytes())
    }

    /// Try to unlock with a recovery key. Returns the master key on success.
    pub fn unlock_with_recovery_key(
        &self,
        recovery_key: &[u8; 16],
    ) -> io::Result<Zeroizing<[u8; 32]>> {
        let kek = kek_from_recovery_key(recovery_key);
        let wrapped = self.master_key_recovery.to_wrapped_key()?;
        unwrap_key(&wrapped, &kek)
    }

    /// Try to unlock with a PRF output. Tries all registered credentials.
    pub fn unlock_with_prf(&self, prf_output: &[u8]) -> io::Result<Zeroizing<[u8; 32]>> {
        if prf_output.len() != 32 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "PRF output must be 32 bytes",
            ));
        }
        let kek = kek_from_prf(prf_output);
        for cred in &self.prf_credentials {
            let wrapped = match cred.wrapped_key.to_wrapped_key() {
                Ok(w) => w,
                Err(_) => continue,
            };
            if let Ok(key) = unwrap_key(&wrapped, &kek) {
                return Ok(key);
            }
        }
        Err(io::Error::new(io::ErrorKind::PermissionDenied, "no matching credential"))
    }
}

/// Walk a notes directory and collect all files that should be encrypted/decrypted.
/// Skips .tansu/settings.json, .tansu/state.json, .tansu/crypto.json, .tansu/index/.
pub fn collect_content_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_recursive(dir, dir, &mut files);
    files
}

fn collect_recursive(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let rel = path.strip_prefix(root).unwrap_or(&path);
        let rel_str = rel.to_string_lossy();

        // Skip the index directory entirely
        if rel_str == ".tansu/index" || rel_str.starts_with(".tansu/index/") {
            continue;
        }
        // Skip non-content .tansu files
        if rel_str == ".tansu/settings.json"
            || rel_str == ".tansu/state.json"
            || rel_str == ".tansu/crypto.json"
        {
            continue;
        }
        // Skip hidden dirs other than .tansu
        if path.is_dir() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.starts_with('.') && name != ".tansu" {
                    continue;
                }
            }
            collect_recursive(root, &path, out);
            continue;
        }

        // Include .md files and anything in z-images/
        let is_md = path.extension().is_some_and(|e| e == "md");
        let in_images = rel_str.starts_with("z-images/");
        if is_md || in_images {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let vault = Vault::from_raw(generate_master_key());
        let plaintext = b"Hello, world!";
        let encrypted = vault.encrypt(plaintext);
        assert!(is_encrypted(&encrypted));
        assert!(!is_encrypted(plaintext));
        let decrypted = vault.decrypt(&encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn encrypt_decrypt_empty() {
        let vault = Vault::from_raw(generate_master_key());
        let encrypted = vault.encrypt(b"");
        let decrypted = vault.decrypt(&encrypted).unwrap();
        assert!(decrypted.is_empty());
    }

    #[test]
    fn decrypt_wrong_key_fails() {
        let vault1 = Vault::from_raw(generate_master_key());
        let vault2 = Vault::from_raw(generate_master_key());
        let encrypted = vault1.encrypt(b"secret");
        assert!(vault2.decrypt(&encrypted).is_err());
    }

    #[test]
    fn decrypt_garbage_fails() {
        let vault = Vault::from_raw(generate_master_key());
        assert!(vault.decrypt(b"not encrypted").is_err());
        assert!(vault.decrypt(b"TNS\x01short").is_err());
    }

    #[test]
    fn key_wrap_unwrap_roundtrip() {
        let master = generate_master_key();
        let kek = generate_master_key(); // reuse for convenience
        let wrapped = wrap_key(&master, &kek);
        let unwrapped = unwrap_key(&wrapped, &kek).unwrap();
        assert_eq!(*unwrapped, master);
    }

    #[test]
    fn key_unwrap_wrong_kek_fails() {
        let master = generate_master_key();
        let kek1 = generate_master_key();
        let kek2 = generate_master_key();
        let wrapped = wrap_key(&master, &kek1);
        assert!(unwrap_key(&wrapped, &kek2).is_err());
    }

    #[test]
    fn recovery_key_format_parse_roundtrip() {
        let key = generate_recovery_key();
        let formatted = format_recovery_key(&key);
        // Should be XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
        assert_eq!(formatted.len(), 39);
        assert_eq!(formatted.chars().filter(|c| *c == '-').count(), 7);
        let parsed = parse_recovery_key(&formatted).unwrap();
        assert_eq!(parsed, key);
    }

    #[test]
    fn recovery_key_parse_no_dashes() {
        let key = generate_recovery_key();
        let hex: String = key.iter().map(|b| format!("{b:02X}")).collect();
        let parsed = parse_recovery_key(&hex).unwrap();
        assert_eq!(parsed, key);
    }

    #[test]
    fn recovery_key_parse_invalid() {
        assert!(parse_recovery_key("too-short").is_err());
        assert!(parse_recovery_key("ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ").is_err());
    }

    #[test]
    fn kek_derivation_deterministic() {
        let rk = generate_recovery_key();
        assert_eq!(kek_from_recovery_key(&rk), kek_from_recovery_key(&rk));

        let prf = generate_master_key(); // 32 bytes
        assert_eq!(kek_from_prf(&prf), kek_from_prf(&prf));
    }

    #[test]
    fn kek_derivation_different_inputs_differ() {
        let rk1 = generate_recovery_key();
        let rk2 = generate_recovery_key();
        assert_ne!(kek_from_recovery_key(&rk1), kek_from_recovery_key(&rk2));
    }

    #[test]
    fn recovery_and_prf_keks_differ() {
        // Even with the same input bytes, different salts → different KEKs
        let input = [0x42u8; 16];
        let recovery_kek = kek_from_recovery_key(&input);
        let prf_kek = kek_from_prf(&input);
        assert_ne!(recovery_kek, prf_kek);
    }

    #[test]
    fn wrapped_key_json_roundtrip() {
        let master = generate_master_key();
        let kek = generate_master_key();
        let wrapped = wrap_key(&master, &kek);
        let json: WrappedKeyJson = (&wrapped).into();
        let json_str = serde_json::to_string(&json).unwrap();
        let json2: WrappedKeyJson = serde_json::from_str(&json_str).unwrap();
        let wrapped2 = json2.to_wrapped_key().unwrap();
        let unwrapped = unwrap_key(&wrapped2, &kek).unwrap();
        assert_eq!(*unwrapped, master);
    }

    #[test]
    fn crypto_config_save_load_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("tansu-test-{}", std::process::id()));
        fs::create_dir_all(tmp.join(".tansu")).unwrap();

        let master = generate_master_key();
        let recovery = generate_recovery_key();
        let kek = kek_from_recovery_key(&recovery);
        let wrapped = wrap_key(&master, &kek);

        let config = CryptoConfig {
            version: 1,
            master_key_recovery: (&wrapped).into(),
            prf_credentials: vec![],
        };
        config.save(&tmp).unwrap();

        let loaded = CryptoConfig::load(&tmp).unwrap();
        assert_eq!(loaded.version, 1);
        assert!(loaded.prf_credentials.is_empty());

        // Unlock with the recovery key
        let unlocked = loaded.unlock_with_recovery_key(&recovery).unwrap();
        assert_eq!(*unlocked, master);

        // Wrong recovery key fails
        let bad_key = [0u8; 16];
        assert!(loaded.unlock_with_recovery_key(&bad_key).is_err());

        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn crypto_config_prf_unlock() {
        let tmp = std::env::temp_dir().join(format!("tansu-test-prf-{}", std::process::id()));
        fs::create_dir_all(tmp.join(".tansu")).unwrap();

        let master = generate_master_key();
        let recovery = generate_recovery_key();
        let rk_kek = kek_from_recovery_key(&recovery);
        let rk_wrapped = wrap_key(&master, &rk_kek);

        // Add a PRF credential
        let prf_output = generate_master_key(); // 32 random bytes
        let prf_kek = kek_from_prf(&prf_output);
        let prf_wrapped = wrap_key(&master, &prf_kek);

        let config = CryptoConfig {
            version: 1,
            master_key_recovery: (&rk_wrapped).into(),
            prf_credentials: vec![PrfCredential {
                id: "test-credential".to_string(),
                name: "Test Device".to_string(),
                created: "2026-04-04T12:00:00Z".to_string(),
                wrapped_key: (&prf_wrapped).into(),
            }],
        };
        config.save(&tmp).unwrap();

        let loaded = CryptoConfig::load(&tmp).unwrap();
        let unlocked = loaded.unlock_with_prf(&prf_output).unwrap();
        assert_eq!(*unlocked, master);

        // Wrong PRF output fails
        let bad_prf = [0u8; 32];
        assert!(loaded.unlock_with_prf(&bad_prf).is_err());

        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn vault_file_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("tansu-test-vault-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();

        let vault = Vault::from_raw(generate_master_key());
        let path = tmp.join("test.md");

        vault.write(&path, b"# Hello\nWorld").unwrap();
        // Raw file should be encrypted
        let raw = fs::read(&path).unwrap();
        assert!(is_encrypted(&raw));
        assert_ne!(&raw, b"# Hello\nWorld");

        let content = vault.read_to_string(&path).unwrap();
        assert_eq!(content, "# Hello\nWorld");

        // Binary read
        let bytes = vault.read(&path).unwrap();
        assert_eq!(bytes, b"# Hello\nWorld");

        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn collect_content_files_selects_correctly() {
        let tmp = std::env::temp_dir().join(format!("tansu-test-collect-{}", std::process::id()));

        // Create test structure
        fs::create_dir_all(tmp.join(".tansu/index")).unwrap();
        fs::create_dir_all(tmp.join(".tansu/revisions/note")).unwrap();
        fs::create_dir_all(tmp.join("z-images")).unwrap();
        fs::create_dir_all(tmp.join("subfolder")).unwrap();
        fs::create_dir_all(tmp.join(".git")).unwrap();

        // Files that should be collected
        fs::write(tmp.join("note.md"), "hello").unwrap();
        fs::write(tmp.join("subfolder/deep.md"), "hello").unwrap();
        fs::write(tmp.join(".tansu/revisions/note/123.md"), "hello").unwrap();
        fs::write(tmp.join("z-images/photo.webp"), "img").unwrap();

        // Files that should be skipped
        fs::write(tmp.join(".tansu/settings.json"), "{}").unwrap();
        fs::write(tmp.join(".tansu/state.json"), "{}").unwrap();
        fs::write(tmp.join(".tansu/crypto.json"), "{}").unwrap();
        fs::write(tmp.join(".tansu/index/meta.json"), "{}").unwrap();
        fs::write(tmp.join(".git/config"), "").unwrap();
        fs::write(tmp.join("readme.txt"), "").unwrap();

        let files = collect_content_files(&tmp);
        let rel: Vec<String> = files
            .iter()
            .map(|p| p.strip_prefix(&tmp).unwrap().to_string_lossy().to_string())
            .collect();

        assert!(rel.contains(&"note.md".to_string()), "should include note.md");
        assert!(rel.contains(&"subfolder/deep.md".to_string()), "should include subfolder/deep.md");
        assert!(
            rel.contains(&".tansu/revisions/note/123.md".to_string()),
            "should include revisions"
        );
        assert!(
            rel.contains(&"z-images/photo.webp".to_string()),
            "should include images"
        );
        assert_eq!(files.len(), 4, "should have exactly 4 files");

        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn full_encrypt_decrypt_directory() {
        let tmp =
            std::env::temp_dir().join(format!("tansu-test-full-enc-{}", std::process::id()));
        fs::create_dir_all(tmp.join(".tansu/revisions/note")).unwrap();
        fs::create_dir_all(tmp.join("z-images")).unwrap();
        fs::create_dir_all(tmp.join("sub")).unwrap();

        let files_content = [
            ("note.md", "# My Note"),
            ("sub/other.md", "hello world"),
            (".tansu/revisions/note/100.md", "old content"),
            ("z-images/photo.webp", "fakepng"),
        ];
        for (rel, content) in &files_content {
            fs::write(tmp.join(rel), content).unwrap();
        }
        fs::write(tmp.join(".tansu/settings.json"), "{}").unwrap();

        // Generate keys and config
        let master = generate_master_key();
        let recovery = generate_recovery_key();
        let kek = kek_from_recovery_key(&recovery);
        let wrapped = wrap_key(&master, &kek);
        let config = CryptoConfig {
            version: 1,
            master_key_recovery: (&wrapped).into(),
            prf_credentials: vec![],
        };
        config.save(&tmp).unwrap();

        // Encrypt all content files
        let vault = Vault::from_raw(master);
        let content_files = collect_content_files(&tmp);
        assert_eq!(content_files.len(), 4);
        for path in &content_files {
            let data = fs::read(path).unwrap();
            assert!(!is_encrypted(&data), "should be plaintext before encrypt");
            vault.write(path, &data).unwrap();
        }

        // Verify files are encrypted on disk
        for path in &content_files {
            let raw = fs::read(path).unwrap();
            assert!(is_encrypted(&raw), "should be encrypted after encrypt");
        }

        // settings.json should be untouched
        assert_eq!(
            fs::read_to_string(tmp.join(".tansu/settings.json")).unwrap(),
            "{}"
        );

        // Idempotency: encrypting already-encrypted files is safe
        for path in &content_files {
            let data = fs::read(path).unwrap();
            if !is_encrypted(&data) {
                vault.write(path, &data).unwrap();
            }
            // Already encrypted, skip — this is what the CLI does
        }

        // Decrypt: load config, unlock, decrypt files
        let loaded_config = CryptoConfig::load(&tmp).unwrap();
        let unlocked_master = loaded_config.unlock_with_recovery_key(&recovery).unwrap();
        let vault2 = Vault::new(unlocked_master);

        for path in &content_files {
            let data = fs::read(path).unwrap();
            assert!(is_encrypted(&data));
            let plaintext = vault2.decrypt(&data).unwrap();
            atomic_write(path, &plaintext).unwrap();
        }

        // Verify content restored
        for (rel, expected) in &files_content {
            let actual = fs::read_to_string(tmp.join(rel)).unwrap();
            assert_eq!(&actual, expected, "content mismatch for {rel}");
        }

        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn prf_unlock_rejects_bad_length() {
        let master = generate_master_key();
        let recovery = generate_recovery_key();
        let kek = kek_from_recovery_key(&recovery);
        let wrapped = wrap_key(&master, &kek);

        let config = CryptoConfig {
            version: 1,
            master_key_recovery: (&wrapped).into(),
            prf_credentials: vec![],
        };

        // Too short
        assert!(config.unlock_with_prf(&[0u8; 16]).is_err());
        // Too long
        assert!(config.unlock_with_prf(&[0u8; 64]).is_err());
        // Empty
        assert!(config.unlock_with_prf(&[]).is_err());
    }

    #[test]
    fn multiple_prf_credentials_any_can_unlock() {
        let master = generate_master_key();
        let recovery = generate_recovery_key();
        let rk_kek = kek_from_recovery_key(&recovery);
        let rk_wrapped = wrap_key(&master, &rk_kek);

        let prf1 = generate_master_key();
        let prf2 = generate_master_key();
        let kek1 = kek_from_prf(&prf1);
        let kek2 = kek_from_prf(&prf2);

        let config = CryptoConfig {
            version: 1,
            master_key_recovery: (&rk_wrapped).into(),
            prf_credentials: vec![
                PrfCredential {
                    id: "cred-1".to_string(),
                    name: "Device 1".to_string(),
                    created: "2026-01-01T00:00:00Z".to_string(),
                    wrapped_key: (&wrap_key(&master, &kek1)).into(),
                },
                PrfCredential {
                    id: "cred-2".to_string(),
                    name: "Device 2".to_string(),
                    created: "2026-01-02T00:00:00Z".to_string(),
                    wrapped_key: (&wrap_key(&master, &kek2)).into(),
                },
            ],
        };

        // Both credentials unlock
        let m1 = config.unlock_with_prf(&prf1).unwrap();
        assert_eq!(*m1, master);
        let m2 = config.unlock_with_prf(&prf2).unwrap();
        assert_eq!(*m2, master);

        // Random PRF output fails
        let bad = generate_master_key();
        assert!(config.unlock_with_prf(&bad).is_err());

        // Recovery key still works
        let mr = config.unlock_with_recovery_key(&recovery).unwrap();
        assert_eq!(*mr, master);
    }

    #[test]
    fn wrap_master_key_never_exposes_raw() {
        let master = generate_master_key();
        let vault = Vault::from_raw(master);
        let kek = generate_master_key();
        let wrapped = vault.wrap_master_key(&kek);

        // Wrapped blob is not the raw master key
        assert_ne!(&wrapped.ciphertext, &master[..]);

        // Can unwrap back to the same master key
        let unwrapped = unwrap_key(&wrapped, &kek).unwrap();
        assert_eq!(*unwrapped, master);
    }

    #[test]
    fn parse_recovery_key_accepts_various_formats() {
        let key = generate_recovery_key();
        let hex_lower: String = key.iter().map(|b| format!("{b:02x}")).collect();
        let hex_upper: String = key.iter().map(|b| format!("{b:02X}")).collect();
        let hex_mixed: String = key
            .iter()
            .enumerate()
            .map(|(i, b)| {
                if i % 2 == 0 {
                    format!("{b:02x}")
                } else {
                    format!("{b:02X}")
                }
            })
            .collect();

        assert_eq!(parse_recovery_key(&hex_lower).unwrap(), key);
        assert_eq!(parse_recovery_key(&hex_upper).unwrap(), key);
        assert_eq!(parse_recovery_key(&hex_mixed).unwrap(), key);

        // Dashes and spaces are stripped (only hex digits kept)
        let formatted = format_recovery_key(&key);
        assert_eq!(parse_recovery_key(&formatted).unwrap(), key);
        let spaced = formatted.replace('-', " ");
        assert_eq!(parse_recovery_key(&spaced).unwrap(), key);
    }

    #[test]
    fn encrypt_produces_unique_ciphertext() {
        // Each encrypt call uses a random nonce → different ciphertext
        let vault = Vault::from_raw(generate_master_key());
        let ct1 = vault.encrypt(b"same content");
        let ct2 = vault.encrypt(b"same content");
        assert_ne!(ct1, ct2, "two encryptions of same plaintext must differ");

        // But both decrypt to the same thing
        assert_eq!(vault.decrypt(&ct1).unwrap(), vault.decrypt(&ct2).unwrap());
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let vault = Vault::from_raw(generate_master_key());
        let mut ct = vault.encrypt(b"important data");
        // Flip a byte in the ciphertext portion (after magic + nonce)
        let last = ct.len() - 1;
        ct[last] ^= 0xFF;
        assert!(vault.decrypt(&ct).is_err(), "tampered ciphertext must fail");
    }
}
