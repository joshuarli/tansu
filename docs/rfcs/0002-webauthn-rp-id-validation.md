# RFC 0002: WebAuthn RP ID validation

**Status:** Proposed

## Problem

`AuthPolicy::authenticated` accepts any dot-delimited suffix of the origin
hostname. It therefore accepts public suffixes such as `com`, although browser
WebAuthn clients require the RP ID to equal the origin's effective domain or be
a registrable domain suffix. Such a configuration passes startup and fails only
when a browser starts a passkey ceremony.

## Options

1. Require the RP ID to equal the configured origin hostname. This has no
   public-suffix dependency but removes valid parent-domain configurations.
2. Validate the RP ID against a maintained public suffix list. This preserves
   registrable parent domains but adds list-update and dependency maintenance.
3. Keep suffix-only validation and rely on browsers to reject invalid values.
   This preserves current behavior but gives a late, confusing error.

## Recommendation

Use a maintained public suffix list, or exact-host validation if its dependency
and binary-size cost exceeds the project's gates. Reject invalid values during
configuration parsing and keep the documented RP ID rules aligned with the
validator.
