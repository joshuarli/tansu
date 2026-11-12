# TNS-109: Workspace write ownership

Status: draft

## Summary

Give each persisted browser workspace one writable owner. Keep additional
windows read-only until the owner releases it. This preserves existing recovery
records while preventing independent editors from overwriting one draft key.
The alternative is independent writers with separate durable drafts and a
recovery interface that can discover all of them.

## Motivation

`createWorkspaceId` in `web/ts/app/workspace-store.ts` returns an origin-wide
localStorage identity. Draft keys combine that workspace with server, vault,
and note identity. Two browser windows therefore write the same record.
Their `DocumentSession` revision counters are independent, but
`mergeDraftJournalRecords` orders those counters as if they had one owner.

An executable probe with the actual sessions and IndexedDB persistence code
wrote different revision-1 drafts from two windows. Both writes succeeded.
Both recovery lookups returned the second draft. The first had no recovery copy.
The storage boundary was fake-indexeddb, so browser ownership and crash release
still need validation in the supported browser engines.

## Design

Retain the persisted workspace identity and journal format. Ownership is scoped
to the server, vault, and workspace tuple used by the existing persistence keys.
Before loading mutable workspace state or accepting edits, acquire exclusive
ownership for that tuple. A browser-managed exclusive lock is preferred if its
lifecycle meets the supported Chromium and WebKit requirements. Avoid an
unfenced timestamp lease that can give a suspended window stale write access.

Ownership covers draft writes and clears, workspace updates, and editor
mutations that rely on those records. A second window shows the notes read-only
and explains which editing action requires ownership. It does not silently
switch to a fresh workspace or overwrite another owner's workspace state.

A voluntary transfer flushes the current owner's journal successfully before
release. A failed flush retains ownership and keeps export available. A crashed
window must release the lock through the browser's lifecycle; the next owner
loads the existing checkpoints before editing. Completions from a released
owner must not write or clear records after transfer. Token or generation checks
belong at the persistence boundary as well as in the UI.

Verification must use two pages or windows sharing the same browser profile,
origin, localStorage, and IndexedDB. Cover these cases:

- Independent edits to one note cannot silently replace a recovery copy.
- A secondary window cannot clear a draft or overwrite workspace state.
- Reload and owner loss preserve recovery under the existing workspace ID.
- A failed flush blocks voluntary transfer; successful persistence allows it.
- A delayed completion from the old owner cannot mutate the new owner's state.

No server protocol, canonical note identity, or vault mutation semantics change.

## Alternatives considered

**Independent concurrent writers.** Add a durable writer discriminator to draft
keys. Enumerate all drafts for a note during recovery instead of choosing the
largest writer-local revision. Preserve old-format rows through an explicit
migration, and provide selection or conflict recovery when several drafts exist.
This supports concurrent editing but requires storage and recovery UI changes.

**Fresh workspace per tab.** Changing only localStorage to sessionStorage or
generating a new workspace ID does not establish safe recovery. A reopened
window may lose the identity needed to find its drafts, and duplicated tabs can
inherit session state. Separate identities need recovery discovery and ownership.

**Timestamp winner.** Last-write-wins ordering still destroys independent authored
content. A timestamp is not evidence that one draft supersedes another.

## Open questions

Should multiple browser windows edit the same persisted workspace concurrently?

- **Recommended:** one writable owner, with other windows read-only. This keeps
  the current journal format and recovery behavior while closing the data-loss path.
- **Alternative:** independent writable windows with separate durable drafts and
  explicit recovery selection. Choose this if parallel editing is required.

## Decision

Pending the owner's choice. No ownership mechanism has been implemented.
