# Upstream

- Upstream: `webauthn-minimal` in `laputa-systems/laputa/mirror/webauthn-minimal`
- Commit: `ef53ce3`
- License: the upstream checkout has no license file or Cargo package license field; distribution rights need owner confirmation.
- Imported path: `src/lib.rs`
- Local patches: enforced user verification, response identity binding, strict COSE and CBOR parsing, extension handling, backup flag validation, DER-only signatures, monotonic counters, and `none`-only attestation.
- Update: compare `src/lib.rs` with the named upstream revision, reapply the listed hardening, and run `cargo test -p tansu-webauthn`.
