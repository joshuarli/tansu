# Alembic Ornaments

Upstream: https://github.com/lauriparonen/alembic-ornaments
Commit: `ec6f48f574e8a1b43b184bfeddd0c4cea140c455` (0.1.0)
License: MIT, retained in `LICENSE`.

Imported from `src/`: `index.ts` and `internal/*.ts`. The React entry
`react.tsx` is excluded; `skin/alembic.ts` draws frames with `fitFrame`.

Local patch: every file starts with `// @ts-nocheck` because upstream is not
written for `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
Drawings are snapshot-tested upstream to the byte, so the source is not
reworked to satisfy them.

To update, compare each imported path against the new upstream commit, copy
the closure and license, and reapply the header.
