# RFC 0001: WebAuthn counter policy

**Status:** Proposed

## Problem

The verifier returns a counter result, but authentication ignores it and issues a
session after a valid signature. The WebAuthn specification describes a
non-increasing nonzero counter as a possible cloned authenticator, malfunction,
or assertion-ordering race. The result is a risk signal, not proof of cloning.
Backup-eligible passkeys make a single rejection rule too broad.

## Decision

Choose the response to a non-increasing counter before changing session
issuance. The policy must distinguish unsupported zero counters, single-device
credentials, and backup-eligible credentials, and must not lower the stored
counter.

## Options

1. Reject authentication for every non-increasing nonzero counter. This is
   simple, but can lock out valid synced passkeys or assertions processed out of
   order.
2. Reject single-device credentials, but permit backup-eligible credentials
   while recording the anomaly. This preserves clone detection where counters
   are most useful, but adds an audit path and still treats backup-eligible
   anomalies as lower risk.
3. Issue the session for all valid signatures and record the anomaly. This
   avoids false lockouts but leaves counter signals out of the authorization
   decision.

## Recommendation

Use option 2, keep the highest observed counter, and record the credential's
backup eligibility and the counter values with the anomaly. The owner should
confirm whether an anomaly also requires a fresh verification before applying
the policy.
