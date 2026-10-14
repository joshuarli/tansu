# RFC 0001: WebAuthn counter policy

**Status:** Accepted

## Problem

The verifier returns a counter result, but authentication ignores it and issues a
session after a valid signature. The WebAuthn specification describes a
non-increasing nonzero counter as a possible cloned authenticator, malfunction,
or assertion-ordering race. The result is a risk signal, not proof of cloning.
Backup-eligible passkeys make a single rejection rule too broad.

## Policy constraints

The policy must distinguish unsupported counters, single-device credentials,
and backup-eligible credentials. It must not lower the stored counter, and an
anomaly must be persisted in the same transaction as any credential and session
update.

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

## Decision

Use option 2. Reject a non-increasing counter for a single-device credential
with the existing unauthorized response and consume its ceremony. For a
backup-eligible credential, accept a cryptographically valid assertion without
extra verification, record the previous and observed counters with backup
eligibility, and issue the session atomically with the anomaly record. Store at
most the latest anomaly per credential. In every accepted case, retain the
highest observed counter.
