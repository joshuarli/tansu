# Search

## Model

- Indexed fields: `title`, `headings`, metadata `tags`, and stripped `content`. `title` is the first markdown heading in the note, falling back to the filename stem when no heading exists. `path` is only an exact filter for scoped in-note search.
- Field weights: `weight_title`, `weight_headings`, `weight_tags`, and `weight_content` are multiplicative boosts at query-build time. Defaults are title `10.0`, headings `5.0`, tags `25.0`, content `1.0`.
- Tokenization: query text is split on non-alphanumeric characters to mirror Tantivy's default tokenizer, so `jpeg-xl` searches as `jpeg` + `xl` and `some_function` as `some` + `function`.
- Quoted queries: double-quoted text adds a literal phrase constraint. `"oat groats"` still contributes `oat` and `groats` as normal terms, but also requires those tokens to appear adjacent and in order.
- Phase 1 query strategy: each non-quoted term becomes a MUST clause. Within each term, all search fields are OR'd together with exact term matches at `1.0x` field weight and prefix matches via `PhrasePrefixQuery` at `0.8x`.
- Phrase strategy: each quoted phrase becomes an additional MUST clause that can match any indexed field at that field's full weight.
- Phase 2 fuzzy fallback: if phase 1 returns fewer than 5 results and `fuzzy_distance > 0`, search is re-run with the same exact, prefix, and phrase clauses plus fuzzy matching on `content` only at `0.6x` content weight.
- Recency boost: after Tantivy returns scored hits, Tansu applies a post-hoc multiplier based on indexed file `mtime`. Settings are `0=disabled`, `1=24 hours`, `2=7 days`, `3=30 days`; the default is `2`.
- Result ordering: when recency boost is enabled, ordering uses the boosted score. When disabled, results stay in Tantivy's native score order.
- Score breakdown: the UI uses `Query::explain()` per sub-query and per field. The breakdown excludes the post-hoc recency multiplier.
- Snippets: snippets are built from stored stripped content, not raw markdown. Quoted searches anchor on the first exact phrase occurrence; normal searches anchor on the first exact, prefix, or fuzzy token match.

## Tags

- Tags are stored in each note's frontmatter and indexed as a separate search field.
- Search treats tag text like any other indexed term for matching and ranking, just with a much higher default weight.
- Rich tag query syntax such as `tag:foo` is not supported.
