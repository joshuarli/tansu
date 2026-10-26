# Product scope

## Rejected features

Tansu excludes in-app AI, including local models and remote model-provider
integrations. Generated summaries and vault chat are outside the product's
scope.

Automatic related-note recommendations are also rejected, even if implemented
without AI. These features make the app infer what matters to the user through
behavior that feels magical and is difficult to predict. Tansu favors explicit
search, links, and editing actions whose results the user can understand.

## Local tag suggestions

Tag suggestions help with manual tagging. They use existing tags from the active
vault and require the user to choose each tag. They use no AI and never apply
tags automatically.

Click **Suggest tags** to view the current tags and search using up to four terms
from the current note's title and text. Frontmatter is excluded. The search checks
up to ten results per term. Suggestions rank existing tags by the number of
distinct matching notes that use them, excluding the current note and its existing tags. Each suggestion
links to its supporting notes. The panel shows at most five suggestions.

Applying a tag is an undoable editor change that follows the normal checkpoint
and save path. Suggestions are discarded when the note changes or another note
or vault opens. Search failures leave the note unchanged and allow another
request. This lexical approach can miss useful tags; it makes no claim to infer
the meaning of a note.

Current tags come from the editor source, including unsaved changes and restored
checkpoints.

## Deferred features

Do not add these to V1 without a design update:

- Vault encryption and offline editing or write queues.
- History pruning, compaction, and import from other revision formats.
- Frontmatter fields beyond tags and remote asset import or versioning.
- A hierarchical file tree and unresolved-state repair UI.
- Packaged app distribution and release signing.
- Native/serverless dual-host deployment; see the
  [unimplemented Cloudflare architecture proposal](serverless-architecture.md).
