# TNS-082: Vault intelligence and model privacy

Status: draft

## Summary

Keep related-note discovery local to the selected vault. Require an explicit
per-vault choice before sending any note content to a model. Model work never
participates in accepting a note write.

## Motivation

The search index already derives results from vault content. Related notes can
reuse that index without introducing a model or another copy of note bodies.
Tag suggestions, summaries, and chat introduce a separate disclosure boundary.
The current configuration has no model provider, credential store, consent
record, or disclosure interface.

## Design

Ship related notes first, using canonical notes in the active vault. Exclude the
current note, tombstones, unresolved notes, and other vaults. Link results by
`noteId`. Treat an unavailable index as an unavailable suggestion panel, without
changing save or reconciliation behavior.

Model features start disabled for every vault. Enabling one requires the owner
to choose a provider and endpoint, the permitted features, and which content may
leave that vault. A local model endpoint and a remote provider are distinct
choices. A loopback URL alone does not prove that a model keeps content local.
Show the destination and selected content before the first disclosure.

Send a request only after the user invokes a permitted feature. Saving a note,
opening a vault, and indexing never trigger model requests. Tag suggestions
return proposals for review. Summaries do not overwrite notes. Chat retrieval
uses only the selected vault and returns citations with note identity and the
revision used. Citation chips open that note and show when the source changed.

Keep provider credentials on the server, outside Markdown and browser storage.
Do not log prompts, responses, credentials, or note bodies. Do not persist model
requests or responses by default. Provider retention and training policies must
be presented as provider policies rather than guarantees made by Tansu.

Bound request size, retrieved context, and concurrent requests. Cancel pending
requests when the vault changes or consent is withdrawn. Already transmitted
content cannot be recalled. Late responses cannot update another vault or
apply tags. A model error leaves the accepted note, snapshots, and search
updates intact. Retrying requires another user action.

After approval, implement related notes, tag suggestions, catch-me-up summaries,
and cited chat as separate vertical slices. Each slice includes its API and
configuration documentation and tests for vault isolation and failure handling.

## Alternatives considered

An entirely local implementation avoids remote disclosure, but requires a
supported model runtime, installation procedure, and resource budget. None is
currently selected.

A remote provider with implicit background requests reduces interaction but
sends authored content without a specific disclosure decision. Reject that
design.

The proposed explicit request boundary supports either hosting choice while
keeping automatic writes and indexing independent from models.

## Open questions

- Which hosting option and provider should Tansu support first?
- Is user-invoked processing sufficient, or should any feature run automatically
  after a separate per-vault consent decision?
- Which credential storage mechanism should the supported deployment use?

## Decision

Await owner approval of hosting, disclosure, and credential storage before
adding model configuration or requests. Related-note discovery requires no
model disclosure, but remains the first implementation slice of this design.
