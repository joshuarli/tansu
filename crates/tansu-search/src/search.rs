use std::ops::Range;

use regex::Regex;
use tantivy::collector::TopDocs;
use tantivy::query::{
    BooleanQuery, BoostQuery, FuzzyTermQuery, Occur, PhrasePrefixQuery, PhraseQuery, Query,
    TermQuery,
};
use tantivy::schema::{IndexRecordOption, Value};
use tantivy::tokenizer::{TokenFilter, TokenStream, Tokenizer};
use tantivy::{DocAddress, Searcher, TantivyDocument, Term};
use unicode_normalization::UnicodeNormalization;

use crate::error::SearchError;
use crate::index::IndexManager;
use crate::schema::doc_text;
use crate::tokenizer::{DiacriticFilter, FerrisearchTokenizer};
use crate::types::{
    ExcerptRange, Fuzziness, NoteRange, SearchMode,
    SearchOptions, SearchResult, SearchWeights,
};

const MAX_QUERY_BYTES: usize = 1024;
const MAX_EXCERPT_BYTES: usize = 512;
const MAX_MATCHES: usize = 100;
const FUZZY_THRESHOLD: usize = 5;

struct ParsedQuery {
    terms: Vec<String>,
    phrases: Vec<Vec<String>>,
}

struct ByteMatch {
    range: Range<usize>,
}

pub(crate) fn execute(
    index: &IndexManager,
    query: &str,
    options: SearchOptions,
) -> Result<Vec<SearchResult>, SearchError> {
    execute_at_most(index, query, options, options.limit.get())
}

pub(crate) fn execute_at_most(
    index: &IndexManager,
    query: &str,
    options: SearchOptions,
    output_limit: usize,
) -> Result<Vec<SearchResult>, SearchError> {
    if query.len() > MAX_QUERY_BYTES {
        return Err(SearchError::QueryTooLong {
            bytes: query.len(),
            maximum: MAX_QUERY_BYTES,
        });
    }
    let query = query.trim();
    if query.is_empty() || options.limit.get() == 0 || output_limit == 0 {
        return Ok(Vec::new());
    }
    let parsed = parse_query(query);
    if parsed.terms.is_empty() && parsed.phrases.is_empty() {
        return Ok(Vec::new());
    }
    if options.mode == SearchMode::TypoOnly && parsed.terms.is_empty() {
        return Ok(Vec::new());
    }
    let all_terms = parsed
        .terms
        .iter()
        .chain(parsed.phrases.iter().flatten())
        .cloned()
        .collect::<Vec<_>>();
    let searcher = index.reader().searcher();
    let (top_docs, fuzziness) = if options.mode == SearchMode::TypoOnly {
        if options.fuzziness == Fuzziness::Disabled {
            return Err(SearchError::InvalidInput { field: "fuzziness" });
        }
        let query = build_search_query(index, &parsed, options, options.fuzziness, true);
        (
            searcher.search(
                &*query,
                &TopDocs::with_limit(output_limit).order_by_score(),
            )?,
            options.fuzziness,
        )
    } else {
        let exact_query = build_search_query(index, &parsed, options, Fuzziness::Disabled, false);
        let search_limit = output_limit.max(FUZZY_THRESHOLD);
        let mut results = searcher.search(
            &*exact_query,
            &TopDocs::with_limit(search_limit).order_by_score(),
        )?;
        let mut effective_fuzziness = Fuzziness::Disabled;
        if results.len() < FUZZY_THRESHOLD
            && options.fuzziness != Fuzziness::Disabled
            && !parsed.terms.is_empty()
        {
            let fuzzy_query = build_search_query(index, &parsed, options, options.fuzziness, false);
            results = searcher.search(
                &*fuzzy_query,
                &TopDocs::with_limit(search_limit).order_by_score(),
            )?;
            effective_fuzziness = options.fuzziness;
        }
        (results, effective_fuzziness)
    };

    let exact_matcher = exact_matcher(&all_terms);
    let result_context = SearchResultContext {
        searcher: &searcher,
        index,
        terms: &all_terms,
        exact_matcher: exact_matcher.as_ref(),
        fuzzy_terms: &parsed.terms,
        fuzziness,
        options,
    };
    let mut results = top_docs
        .into_iter()
        .filter_map(|(score, address)| {
            make_result(&result_context, address, score).transpose()
        })
        .collect::<Result<Vec<_>, SearchError>>()?;
    results.truncate(output_limit);
    Ok(results)
}

fn build_search_query(
    index: &IndexManager,
    parsed: &ParsedQuery,
    options: SearchOptions,
    fuzziness: Fuzziness,
    fuzzy_only: bool,
) -> Box<dyn Query> {
    let fields = index.fields();
    let mut must_clauses = parsed
        .terms
        .iter()
        .map(|term| {
            let field_queries = fields
                .text_fields()
                .iter()
                .flat_map(|(name, field)| {
                    let boost = field_weight(name, &options.weights);
                    let exact_term = Term::from_field_text(*field, term);
                    let mut queries: Vec<(Occur, Box<dyn Query>)> = Vec::new();
                    if fuzzy_only {
                        let distance = fuzziness.distance_for(term);
                        if distance > 0 {
                            queries.push((
                                Occur::Should,
                                Box::new(BoostQuery::new(
                                    Box::new(FuzzyTermQuery::new(exact_term, distance, true)),
                                    boost,
                                )),
                            ));
                        }
                    } else {
                        queries.push((
                            Occur::Should,
                            Box::new(BoostQuery::new(
                                Box::new(TermQuery::new(
                                    exact_term.clone(),
                                    IndexRecordOption::WithFreqs,
                                )),
                                boost,
                            )),
                        ));
                        queries.push((
                            Occur::Should,
                            Box::new(BoostQuery::new(
                                Box::new(PhrasePrefixQuery::new(vec![exact_term.clone()])),
                                boost * 0.8,
                            )),
                        ));
                        if name == &"content" && fuzziness != Fuzziness::Disabled {
                            let distance = fuzziness.distance_for(term);
                            if distance > 0 {
                                queries.push((
                                    Occur::Should,
                                    Box::new(BoostQuery::new(
                                        Box::new(FuzzyTermQuery::new(exact_term, distance, true)),
                                        boost * 0.6,
                                    )),
                                ));
                            }
                        }
                    }
                    queries
                })
                .collect::<Vec<_>>();
            (
                Occur::Must,
                Box::new(BooleanQuery::new(field_queries)) as Box<dyn Query>,
            )
        })
        .collect::<Vec<_>>();

    for phrase in &parsed.phrases {
        let field_queries = fields
            .text_fields()
            .iter()
            .map(|(name, field)| {
                let boost = field_weight(name, &options.weights);
                let terms = phrase
                    .iter()
                    .map(|term| Term::from_field_text(*field, term))
                    .collect::<Vec<_>>();
                (
                    Occur::Should,
                    Box::new(BoostQuery::new(
                        Box::new(PhraseQuery::new(terms)),
                        boost,
                    )) as Box<dyn Query>,
                )
            })
            .collect::<Vec<_>>();
        must_clauses.push((
            Occur::Must,
            Box::new(BooleanQuery::new(field_queries)) as Box<dyn Query>,
        ));
    }
    Box::new(BooleanQuery::new(must_clauses))
}

#[derive(Clone, Copy)]
struct SearchResultContext<'a> {
    searcher: &'a Searcher,
    index: &'a IndexManager,
    terms: &'a [String],
    exact_matcher: Option<&'a Regex>,
    fuzzy_terms: &'a [String],
    fuzziness: Fuzziness,
    options: SearchOptions,
}

fn make_result(
    context: &SearchResultContext<'_>,
    address: DocAddress,
    score: f32,
) -> Result<Option<SearchResult>, SearchError> {
    let SearchResultContext {
        searcher,
        index,
        terms,
        exact_matcher,
        fuzzy_terms,
        fuzziness,
        options,
    } = *context;
    let document = searcher.doc::<TantivyDocument>(address)?;
    let note_id = doc_text(&document, index.fields().note_id);
    let path = doc_text(&document, index.fields().path);
    let title = doc_text(&document, index.fields().title);
    let source_hash = doc_text(&document, index.fields().source_hash);
    let revision = document
        .get_first(index.fields().revision)
        .and_then(|value| value.as_u64())
        .and_then(|value| i64::try_from(value).ok())
        .ok_or(SearchError::CorruptIndex)?;
    let content = doc_text(&document, index.fields().content);
    let mut byte_matches = exact_matcher
        .map(|matcher| find_exact_matches(&content, matcher))
        .unwrap_or_default();
    let fuzzy_matches = find_fuzzy_matches(&content, fuzzy_terms, fuzziness);
    if options.mode == SearchMode::TypoOnly {
        if !has_fuzzy_field_match(index, &document, fuzzy_terms, fuzziness) {
            return Ok(None);
        }
        byte_matches.extend(fuzzy_matches);
    } else if fuzziness != Fuzziness::Disabled {
        byte_matches.extend(fuzzy_matches);
        byte_matches.sort_by_key(|matched| (matched.range.start, matched.range.end));
        byte_matches.dedup_by(|left, right| left.range == right.range);
    }
    let (excerpt, excerpt_ranges) = build_excerpt(&content, &byte_matches)?;
    let source_reveal_range = byte_matches
        .first()
        .map(|matched| utf16_range(&content, matched.range.clone()))
        .transpose()?;
    Ok(Some(SearchResult {
        note_id,
        revision,
        source_hash,
        title,
        path,
        score,
        matched_terms: terms.to_vec(),
        excerpt,
        excerpt_ranges,
        source_reveal_range,
        local_revision: None,
    }))
}

fn has_fuzzy_field_match(
    index: &IndexManager,
    document: &TantivyDocument,
    terms: &[String],
    fuzziness: Fuzziness,
) -> bool {
    index
        .fields()
        .text_fields()
        .into_iter()
        .flat_map(|(_, field)| {
            document
                .get_all(field)
                .filter_map(|value| value.as_str())
                .collect::<Vec<_>>()
        })
        .any(|text| !find_fuzzy_matches(text, terms, fuzziness).is_empty())
}

fn field_weight(name: &str, weights: &SearchWeights) -> f32 {
    match name {
        "title" => weights.title,
        "path" => SearchWeights::PATH,
        "headings" => weights.headings,
        "tags" => weights.tags,
        "content" => weights.content,
        _ => 0.0,
    }
}

const RECENCY_HALF_LIFE_MS: f64 = 30.0 * 24.0 * 3_600_000.0;

pub(crate) fn rank_hits(
    hits: &mut [SearchResult],
    updated_at_ms: impl Fn(&SearchResult) -> i64,
    options: &SearchOptions,
) {
    for hit in hits.iter_mut().filter(|_| options.weights.recency_boost != 0.0) {
        let age_ms = options.now_ms.saturating_sub(updated_at_ms(hit)).max(0) as f64;
        let decay = 0.5_f64.powf(age_ms / RECENCY_HALF_LIFE_MS);
        hit.score *= 1.0 + options.weights.recency_boost * decay as f32;
    }
    hits.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.note_id.cmp(&right.note_id))
    });
}

fn parse_query(input: &str) -> ParsedQuery {
    let mut terms = Vec::new();
    let mut phrases = Vec::new();
    let mut chars = input.chars().peekable();
    while let Some(&character) = chars.peek() {
        if character.is_whitespace() {
            chars.next();
            continue;
        }
        if character == '"' {
            chars.next();
            let mut phrase_text = String::new();
            let mut closed = false;
            for character in chars.by_ref() {
                if character == '"' {
                    closed = true;
                    break;
                }
                phrase_text.push(character);
            }
            let tokenized = tokenize_query_text(&phrase_text);
            if closed {
                let mut words = Vec::new();
                let mut last_position = None;
                for (position, word) in tokenized {
                    if last_position != Some(position) {
                        words.push(word);
                        last_position = Some(position);
                    }
                }
                match words.len() {
                    0 => {}
                    1 => terms.push(words.remove(0)),
                    _ => phrases.push(words),
                }
            } else {
                terms.extend(tokenized.into_iter().map(|(_, word)| word));
            }
        } else {
            let mut word = String::new();
            while let Some(&character) = chars.peek() {
                if character.is_whitespace() || character == '"' {
                    break;
                }
                word.push(character);
                chars.next();
            }
            terms.extend(
                tokenize_query_text(&word)
                    .into_iter()
                    .map(|(_, token)| token),
            );
        }
    }
    ParsedQuery { terms, phrases }
}

fn tokenize_query_text(input: &str) -> Vec<(usize, String)> {
    let mut tokenizer = DiacriticFilter.transform(FerrisearchTokenizer::new());
    let mut stream = tokenizer.token_stream(input);
    let mut tokens = Vec::new();
    while stream.advance() {
        let token = stream.token();
        tokens.push((token.position, token.text.clone()));
    }
    tokens
}

fn exact_matcher(terms: &[String]) -> Option<Regex> {
    if terms.is_empty() {
        return None;
    }
    let mut sorted = terms.iter().map(String::as_str).collect::<Vec<_>>();
    sorted.sort_by_key(|term| std::cmp::Reverse(term.len()));
    sorted.dedup();
    let expression = sorted
        .iter()
        .map(|term| regex::escape(term))
        .collect::<Vec<_>>()
        .join("|");
    Regex::new(&format!("(?i){expression}")).ok()
}

fn find_exact_matches(content: &str, matcher: &Regex) -> Vec<ByteMatch> {
    if content.is_empty() {
        return Vec::new();
    }
    let (normalized, mapping) = strip_diacritics_with_mapping(content);
    matcher
        .find_iter(&normalized)
        .take(MAX_MATCHES)
        .filter_map(|matched| {
            let start = *mapping.get(matched.start())?;
            let end = *mapping.get(matched.end())?;
            (start < end).then_some(ByteMatch { range: start..end })
        })
        .collect()
}

fn find_fuzzy_matches(content: &str, terms: &[String], fuzziness: Fuzziness) -> Vec<ByteMatch> {
    if terms.is_empty() || content.is_empty() || fuzziness == Fuzziness::Disabled {
        return Vec::new();
    }
    let word_regex = regex::Regex::new(r"[^\p{P}\p{Z}\p{Cc}\p{S}]+").unwrap();
    let (normalized, mapping) = strip_diacritics_with_mapping(content);
    let term_distances = terms
        .iter()
        .map(|term| (normalize(term), fuzziness.distance_for(term)))
        .filter(|(_, distance)| *distance > 0)
        .collect::<Vec<_>>();
    let mut matches = Vec::new();
    for word in word_regex.find_iter(&normalized) {
        if matches.len() >= MAX_MATCHES {
            break;
        }
        let normalized_word = normalize(word.as_str());
        let fuzzy = term_distances.iter().any(|(term, maximum)| {
            let distance = osa_distance(&normalized_word, term);
            distance > 0 && distance <= usize::from(*maximum)
        });
        if !fuzzy {
            continue;
        }
        let Some(&start) = mapping.get(word.start()) else {
            continue;
        };
        let Some(&end) = mapping.get(word.end()) else {
            continue;
        };
        if start < end {
            matches.push(ByteMatch { range: start..end });
        }
    }
    matches
}

fn strip_diacritics_with_mapping(text: &str) -> (String, Vec<usize>) {
    let mut result = String::new();
    let mut mapping = vec![0];
    for (start, original) in text.char_indices() {
        let end = start + original.len_utf8();
        if original.is_ascii() {
            result.push(original);
            mapping.push(end);
            continue;
        }
        let mut buffer = [0; 4];
        let normalized = original
            .encode_utf8(&mut buffer)
            .nfd()
            .filter(|character| !unicode_normalization::char::is_combining_mark(*character))
            .nfc()
            .collect::<String>();
        if normalized.is_empty() {
            if let Some(boundary) = mapping.last_mut() {
                *boundary = end;
            }
            continue;
        }
        result.push_str(&normalized);
        for byte_index in 0..normalized.len() {
            mapping.push(if byte_index + 1 == normalized.len() {
                end
            } else {
                start
            });
        }
    }
    (result, mapping)
}

fn normalize(text: &str) -> String {
    text.nfd()
        .filter(|character| !unicode_normalization::char::is_combining_mark(*character))
        .collect::<String>()
        .to_lowercase()
}

fn osa_distance(left: &str, right: &str) -> usize {
    let left = left.chars().collect::<Vec<_>>();
    let right = right.chars().collect::<Vec<_>>();
    if left.len().abs_diff(right.len()) > 2 {
        return 3;
    }
    let mut matrix = vec![vec![0; right.len() + 1]; left.len() + 1];
    for (row, values) in matrix.iter_mut().enumerate() {
        values[0] = row;
    }
    for (column, value) in matrix[0].iter_mut().enumerate() {
        *value = column;
    }
    for row in 1..=left.len() {
        for column in 1..=right.len() {
            let substitution = usize::from(left[row - 1] != right[column - 1]);
            matrix[row][column] = (matrix[row - 1][column] + 1)
                .min(matrix[row][column - 1] + 1)
                .min(matrix[row - 1][column - 1] + substitution);
            if row > 1
                && column > 1
                && left[row - 1] == right[column - 2]
                && left[row - 2] == right[column - 1]
            {
                matrix[row][column] = matrix[row][column].min(matrix[row - 2][column - 2] + 1);
            }
        }
    }
    matrix[left.len()][right.len()]
}

fn build_excerpt(
    content: &str,
    matches: &[ByteMatch],
) -> Result<(String, Vec<ExcerptRange>), SearchError> {
    let Some(first) = matches.first() else {
        return Ok((String::new(), Vec::new()));
    };
    let first_start = first.range.start;
    let candidate_start = floor_char_boundary(content, first_start.saturating_sub(200));
    let start = content[candidate_start..first_start]
        .rfind(char::is_whitespace)
        .map(|offset| {
            let whitespace_start = candidate_start + offset;
            whitespace_start
                + content[whitespace_start..]
                    .chars()
                    .next()
                    .unwrap()
                    .len_utf8()
        })
        .filter(|start| *start < first_start)
        .unwrap_or(candidate_start);
    let prefix = usize::from(start > 0) * '…'.len_utf8();
    let budget = MAX_EXCERPT_BYTES.saturating_sub(prefix + 3);
    let mut end = floor_char_boundary(content, (start + budget).min(content.len()));
    if end < content.len() {
        end = content[start..end]
            .rfind(char::is_whitespace)
            .map(|boundary| start + boundary)
            .filter(|candidate| *candidate > first_start)
            .unwrap_or(end);
    }
    let suffix = end < content.len();
    let mut excerpt = String::new();
    if start > 0 {
        excerpt.push('…');
    }
    let inner_start = excerpt.len();
    excerpt.push_str(&content[start..end]);
    let inner_end = excerpt.len();
    if suffix {
        excerpt.push('…');
    }
    let mut ranges = Vec::new();
    for matched in matches {
        let match_start = matched.range.start;
        let match_end = matched.range.end;
        if match_start < start || match_end > end {
            continue;
        }
        let local_start = inner_start + match_start - start;
        let local_end = inner_start + match_end - start;
        let range = utf16_range(&excerpt, local_start..local_end)?;
        ranges.push(ExcerptRange::new(range.start(), range.end())?);
    }
    if inner_end > MAX_EXCERPT_BYTES || excerpt.len() > MAX_EXCERPT_BYTES {
        return Err(SearchError::CorruptIndex);
    }
    Ok((excerpt, ranges))
}

fn utf16_offset(content: &str, byte_offset: usize) -> Result<u32, SearchError> {
    if !content.is_char_boundary(byte_offset) {
        return Err(SearchError::CorruptIndex);
    }
    content[..byte_offset]
        .chars()
        .try_fold(0u32, |offset, character| {
            offset.checked_add(character.len_utf16() as u32)
        })
        .ok_or(SearchError::CorruptIndex)
}

fn utf16_range(content: &str, byte_range: Range<usize>) -> Result<NoteRange, SearchError> {
    let matched = content
        .get(byte_range.clone())
        .ok_or(SearchError::CorruptIndex)?;
    let start = utf16_offset(content, byte_range.start)?;
    let end = matched
        .chars()
        .try_fold(start, |offset, character| {
            offset.checked_add(character.len_utf16() as u32)
        })
        .ok_or(SearchError::CorruptIndex)?;
    NoteRange::new(start, end)
}

fn floor_char_boundary(content: &str, mut index: usize) -> usize {
    while !content.is_char_boundary(index) {
        index -= 1;
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::IndexManager;
    use crate::types::{DocumentInput, MatchInfo, NoteIdentity, SearchLimit};

    fn make_doc(
        note_id: &str,
        path: &str,
        title: &str,
        content: &str,
        headings: &str,
        tags: &[&str],
        revision: i64,
    ) -> DocumentInput {
        let identity = NoteIdentity::new(
            note_id.into(),
            path.into(),
            title.into(),
            tags.iter().map(|tag| (*tag).to_owned()).collect(),
            revision,
            format!("blake3-v3:{revision}"),
        )
        .unwrap();
        DocumentInput::new(identity, content.into(), headings.into()).unwrap()
    }

    fn doc(note_id: &str, content: &str) -> DocumentInput {
        make_doc(
            note_id,
            &format!("{note_id}.md"),
            note_id,
            content,
            "",
            &[],
            1,
        )
    }

    fn setup_index(docs: Vec<DocumentInput>) -> IndexManager {
        let mut index = IndexManager::new_in_memory().unwrap();
        index.upsert_batch(&docs).unwrap();
        index
    }

    fn options() -> SearchOptions {
        SearchOptions {
            fuzziness: Fuzziness::Disabled,
            ..SearchOptions::default()
        }
    }

    fn results(index: &IndexManager, query: &str, options: SearchOptions) -> Vec<SearchResult> {
        execute(index, query, options).unwrap()
    }

    #[test]
    fn resolves_term_queries() {
        let cases: Vec<(Vec<DocumentInput>, &str, Vec<&str>)> = vec![
            (vec![doc("a", "hello world")], "hello", vec!["a"]),
            (
                vec![doc("a", "hello world"), doc("b", "hello only")],
                "hello world",
                vec!["a"],
            ),
            (vec![doc("a", "hello world")], "", vec![]),
            (vec![doc("a", "hello world")], " \t\n ", vec![]),
            (vec![doc("a", "hello world")], "xyzzynonexistent", vec![]),
            (vec![doc("a", "x marks the spot")], "x", vec!["a"]),
            (
                vec![doc("a", "internationalization is important")],
                "intern",
                vec!["a"],
            ),
            (
                vec![make_doc("a", "a.md", "a", "body text", "", &[], 1)],
                "nickname",
                vec![],
            ),
            (
                vec![make_doc("a", "a.md", "a", "body text", "", &[], 1)],
                "programming",
                vec![],
            ),
        ];
        for (docs, query, expected) in cases {
            let index = setup_index(docs);
            let ids = results(&index, query, options())
                .into_iter()
                .map(|hit| hit.note_id)
                .collect::<Vec<_>>();
            assert_eq!(ids, expected, "query: {query:?}");
        }
    }

    #[test]
    fn ranks_field_matches_by_weight() {
        let filler = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
        let cases: Vec<(Vec<DocumentInput>, &str, Option<SearchWeights>, Vec<&str>)> = vec![
            (
                vec![
                    make_doc("body", "body.md", "other", "search", "", &[], 1),
                    make_doc("title", "title.md", "search", "other", "", &[], 1),
                ],
                "search",
                None,
                vec!["title", "body"],
            ),
            (
                vec![
                    make_doc(
                        "body",
                        "n1.md",
                        "first",
                        &format!("{filler} gardening {filler}"),
                        "",
                        &[],
                        1,
                    ),
                    make_doc("tagged", "n2.md", "second", filler, "", &["gardening"], 1),
                ],
                "gardening",
                None,
                vec!["tagged", "body"],
            ),
            (
                vec![
                    make_doc("partial", "n1.md", "first", "body", "", &["gardening"], 1),
                    make_doc("exact", "n2.md", "second", "body", "", &["garden"], 1),
                ],
                "garden",
                None,
                vec!["exact", "partial"],
            ),
            (
                vec![make_doc("a", "a.md", "a", "body", "Important Heading", &[], 1)],
                "important",
                None,
                vec!["a"],
            ),
            (
                vec![make_doc("a", "a.md", "a", "body", "", &["cooking"], 1)],
                "cooking",
                None,
                vec!["a"],
            ),
            (
                vec![
                    make_doc("t", "t.md", "needle", "plain", "", &[], 1),
                    make_doc("c", "c.md", "other", "needle", "", &[], 1),
                ],
                "needle",
                None,
                vec!["t", "c"],
            ),
            (
                vec![
                    make_doc("t", "t.md", "needle", "plain", "", &[], 1),
                    make_doc("c", "c.md", "other", "needle", "", &[], 1),
                ],
                "needle",
                Some(SearchWeights::new(1.0, 5.0, 2.0, 50.0, 0.0).unwrap()),
                vec!["c", "t"],
            ),
        ];
        for (docs, query, weights, expected) in cases {
            let index = setup_index(docs);
            let mut current = options();
            if let Some(weights) = weights {
                current = current.with_weights(weights);
            }
            let ids = results(&index, query, current)
                .into_iter()
                .map(|hit| hit.note_id)
                .collect::<Vec<_>>();
            assert_eq!(ids, expected, "query: {query:?}");
        }

        let index = setup_index(vec![make_doc("t", "t.md", "needle", "plain", "", &[], 1)]);
        let explicit = SearchWeights::new(10.0, 5.0, 2.0, 1.0, 0.0).unwrap();
        let default_hit = &results(&index, "needle", options())[0];
        let explicit_hit = &results(&index, "needle", options().with_weights(explicit))[0];
        assert_eq!(default_hit.score, explicit_hit.score);
    }

    #[test]
    fn shapes_result_hits() {
        let index = setup_index(vec![make_doc(
            "note-id",
            "folder/a.md",
            "Title",
            "stored body",
            "",
            &[],
            7,
        )]);
        let hit = &results(&index, "stored", options())[0];
        assert_eq!(hit.note_id, "note-id");
        assert_eq!(hit.path, "folder/a.md");
        assert_eq!(hit.title, "Title");
        assert_eq!(hit.revision, 7);
        assert_eq!(hit.source_hash, "blake3-v3:7");
        assert!(!hit.excerpt.is_empty());

        drop(index);
        let index = setup_index(vec![doc("a", "Hello World")]);
        let hit = &results(&index, "Hello World", options())[0];
        assert_eq!(hit.matched_terms, ["hello", "world"]);

        drop(index);
        let index = setup_index(vec![doc("a", "Hello world, this is a test document")]);
        let hits = results(&index, "hello test", options());
        assert_eq!(hits[0].excerpt_ranges.len(), 2);

        drop(index);
        let long = format!("{}needle{}", "before ".repeat(100), " after".repeat(100));
        let index = setup_index(vec![doc("long", &long), doc("filename", "other")]);
        let hit = results(&index, "needle", options()).remove(0);
        assert!(hit.excerpt.len() <= MAX_EXCERPT_BYTES);
        assert!(hit.source_reveal_range.is_some());
        drop(index);
        let filename = setup_index(vec![make_doc(
            "file",
            "needle-file.md",
            "needle-file",
            "other words",
            "",
            &[],
            1,
        )]);
        let hit = results(&filename, "needle", options()).remove(0);
        assert!(hit.source_reveal_range.is_none());
        assert!(hit.excerpt.is_empty());

        drop(filename);
        let content = "---\ntags: [one]\n---\n\te\u{301} 😀 needle needle";
        let index = setup_index(vec![make_doc("a", "a.md", "a", content, "", &["one"], 1)]);
        let hit = results(&index, "needle", options()).remove(0);
        assert_eq!(hit.source_reveal_range.as_ref().unwrap().start(), 27);
        assert_eq!(hit.excerpt_ranges.len(), 2);
    }

    #[test]
    fn measures_edit_distance() {
        for (left, right, expected) in [
            ("powder", "powder", 0),
            ("powder", "pwoder", 1),
            ("powder", "powdr", 1),
            ("powder", "poweder", 1),
        ] {
            assert_eq!(osa_distance(left, right), expected);
        }
        assert_eq!(Fuzziness::OneEdit.distance_for("cat"), 0);
        assert_eq!(Fuzziness::OneEdit.distance_for("tacos"), 1);
        assert_eq!(Fuzziness::TwoEdits.distance_for("tacoshop"), 2);
    }

    #[test]
    fn applies_fuzziness_levels() {
        let cases: Vec<(Vec<DocumentInput>, &str, Fuzziness, Vec<&str>)> = vec![
            (
                vec![doc("typo", "pwoder")],
                "powder",
                Fuzziness::OneEdit,
                vec!["typo"],
            ),
            (
                vec![doc("typo", "pwoder")],
                "powder",
                Fuzziness::Disabled,
                vec![],
            ),
            (
                vec![doc("typo", "pwoder")],
                "powder",
                Fuzziness::TwoEdits,
                vec!["typo"],
            ),
            (
                vec![doc("exact", "powder"), doc("typo", "pwoder")],
                "powder",
                Fuzziness::TwoEdits,
                vec!["exact", "typo"],
            ),
        ];
        for (docs, query, fuzziness, mut expected) in cases {
            let index = setup_index(docs);
            let mut ids = results(
                &index,
                query,
                SearchOptions {
                    fuzziness,
                    ..options()
                },
            )
            .into_iter()
            .map(|hit| hit.note_id)
            .collect::<Vec<_>>();
            ids.sort();
            expected.sort();
            assert_eq!(ids, expected, "query: {query:?}");
        }
    }

    #[test]
    fn searches_typo_only_mode() {
        let typo_options = |fuzziness| SearchOptions {
            mode: SearchMode::TypoOnly,
            fuzziness,
            ..options()
        };
        let cases: Vec<(Vec<DocumentInput>, &str, Fuzziness, Vec<&str>)> = vec![
            (
                vec![doc("typo", "pwoder")],
                "powder",
                Fuzziness::TwoEdits,
                vec!["typo"],
            ),
            (
                vec![doc("mixed", "powder pwoder")],
                "powder",
                Fuzziness::TwoEdits,
                vec!["mixed"],
            ),
            (
                vec![doc("exact", "powder"), doc("typo", "pwoder")],
                "powder",
                Fuzziness::TwoEdits,
                vec!["typo"],
            ),
            (vec![doc("a", "fox")], "fox", Fuzziness::TwoEdits, vec![]),
            (
                vec![doc("typo", "pwoder milk")],
                "\"powder milk\"",
                Fuzziness::TwoEdits,
                vec![],
            ),
        ];
        for (docs, query, fuzziness, expected) in cases {
            let index = setup_index(docs);
            let ids = results(&index, query, typo_options(fuzziness))
                .into_iter()
                .map(|hit| hit.note_id)
                .collect::<Vec<_>>();
            assert_eq!(ids, expected, "query: {query:?}");
        }

        let index = setup_index(vec![doc("typo", "pwoder")]);
        let hits = results(&index, "powder", typo_options(Fuzziness::TwoEdits));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note_id, "typo");
        assert!(hits[0].source_reveal_range.is_some());

        drop(index);
        let index = setup_index(vec![make_doc(
            "typo-path",
            "pwoder.md",
            "Recipe",
            "body only",
            "",
            &[],
            1,
        )]);
        let hits = results(&index, "powder", typo_options(Fuzziness::OneEdit));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "pwoder.md");
        assert!(hits[0].source_reveal_range.is_none());
        assert!(hits[0].excerpt_ranges.is_empty());
    }

    #[test]
    fn field_boosts_for_field() {
        for (field, weight) in [
            ("title", 10.0),
            ("path", 7.0),
            ("headings", 5.0),
            ("tags", 2.0),
            ("content", 1.0),
        ] {
            assert_eq!(field_weight(field, &SearchWeights::default()), weight);
        }
    }

    #[test]
    fn validates_search_options() {
        assert_eq!(SearchOptions::default().mode, SearchMode::ExactPrefix);
        assert_eq!(SearchOptions::default().fuzziness, Fuzziness::OneEdit);
        for bad in [f32::NAN, -1.0, f32::INFINITY, SearchWeights::MAX + 1.0] {
            assert!(SearchWeights::new(bad, 1.0, 1.0, 1.0, 0.0).is_err());
            assert!(SearchWeights::new(1.0, 1.0, 1.0, 1.0, bad).is_err());
        }

        let index = setup_index(vec![doc("a", "body")]);
        let query = "x".repeat(MAX_QUERY_BYTES + 1);
        assert!(matches!(
            execute(&index, &query, options()),
            Err(SearchError::QueryTooLong {
                bytes: 1025,
                maximum: 1024
            })
        ));
    }

    #[test]
    fn limits_results_before_sparse_fallback() {
        let docs = (0..10).map(|i| doc(&i.to_string(), "common search term")).collect();
        let index = setup_index(docs);
        let limited = SearchOptions {
            limit: SearchLimit::try_from(3).unwrap(),
            ..self::options()
        };
        assert_eq!(results(&index, "common", limited).len(), 3);

        drop(index);
        let index = setup_index(vec![
            make_doc("best", "best.md", "Powder", "powder pwoder", "", &[], 1),
            doc("exact-1", "powder"),
            doc("exact-2", "powder"),
            doc("exact-3", "powder"),
            doc("exact-4", "powder"),
            doc("typo", "pwoder"),
        ]);
        let hits = results(
            &index,
            "powder",
            SearchOptions {
                fuzziness: Fuzziness::OneEdit,
                limit: SearchLimit::try_from(1).unwrap(),
                ..options()
            },
        );
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].excerpt_ranges.len(), 1);
    }

    #[test]
    fn matches_phrases_against_documents() {
        let cases: Vec<(Vec<DocumentInput>, &str, Vec<&str>)> = vec![
            (
                vec![doc("a", "the quick brown fox"), doc("b", "brown quick fox")],
                "\"quick brown\"",
                vec!["a"],
            ),
            (
                vec![doc("a", "the brown quick fox")],
                "\"quick brown\"",
                vec![],
            ),
            (
                vec![doc("a", "quick red brown fox")],
                "\"quick brown\"",
                vec![],
            ),
            (
                vec![
                    doc("a", "quick brown fox lazy dog"),
                    doc("b", "lazy dog sleeps"),
                ],
                "\"quick brown\" lazy",
                vec!["a"],
            ),
            (vec![doc("a", "hello world")], "\"hello\"", vec!["a"]),
            (
                vec![
                    doc("a", "quick brown fox and lazy dog"),
                    doc("b", "quick brown fox and busy cat"),
                ],
                "\"quick brown\" \"lazy dog\"",
                vec!["a"],
            ),
            (vec![doc("a", "hello world")], "\"\"", vec![]),
            (
                vec![doc("a", "hello beautiful world")],
                "\"hello world",
                vec!["a"],
            ),
            (
                vec![make_doc("a", "a.md", "a", "body", "quick brown fox", &[], 1)],
                "\"quick brown\"",
                vec!["a"],
            ),
            (
                vec![doc("a", "myVariable is great")],
                "\"variable is\"",
                vec!["a"],
            ),
        ];
        for (docs, query, expected) in cases {
            let index = setup_index(docs);
            let ids = results(&index, query, options())
                .into_iter()
                .map(|hit| hit.note_id)
                .collect::<Vec<_>>();
            assert_eq!(ids, expected, "query: {query:?}");
        }

        let index = setup_index(vec![doc("a", "quick brown fox")]);
        let hit = &results(&index, "\"quick brown\" fox", options())[0];
        assert!(hit.matched_terms.contains(&"quick".to_string()));
        assert!(hit.matched_terms.contains(&"brown".to_string()));
        assert!(hit.matched_terms.contains(&"fox".to_string()));
    }

    #[test]
    fn parses_search_queries() {
        let cases: &[(&str, &[&str], &[&[&str]])] = &[
            ("hello world", &["hello", "world"], &[]),
            ("\"quick brown\"", &[], &[&["quick", "brown"]]),
            (
                "hello \"quick brown\" world",
                &["hello", "world"],
                &[&["quick", "brown"]],
            ),
            ("\"hello\"", &["hello"], &[]),
            ("\"\"", &[], &[]),
            ("\"hello world", &["hello", "world"], &[]),
            (
                "\"foo bar\" \"baz qux\"",
                &[],
                &[&["foo", "bar"], &["baz", "qux"]],
            ),
            ("Hello \"FOO Bar\"", &["hello"], &[&["foo", "bar"]]),
        ];
        for (input, terms, phrases) in cases {
            let parsed = parse_query(input);
            assert_eq!(parsed.terms, terms.to_vec(), "input: {input:?}");
            let parsed_phrases = parsed
                .phrases
                .iter()
                .map(|phrase| phrase.iter().map(String::as_str).collect::<Vec<_>>())
                .collect::<Vec<_>>();
            assert_eq!(parsed_phrases, phrases.to_vec(), "input: {input:?}");
        }
    }

    fn extract(content: &str, terms: &[String], _ignore_diacritics: bool) -> Vec<MatchInfo> {
        exact_matcher(terms)
            .map(|matcher| find_exact_matches(content, &matcher))
            .unwrap_or_default()
            .into_iter()
            .map(|matched| {
                let start = utf16_offset(content, matched.range.start).unwrap();
                let end = utf16_offset(content, matched.range.end).unwrap();
                MatchInfo {
                    match_text: content[matched.range.clone()].to_owned(),
                    range: NoteRange::new(start, end).unwrap(),
                    fuzzy: false,
                }
            })
            .collect()
    }

    #[test]
    fn finds_exact_matches_with_source_offsets() {
        let capped_content = "word ".repeat(200);
        let capped_expected: Vec<(String, u32, u32)> = (0..MAX_MATCHES)
            .map(|i| ("word".to_string(), 5 * i as u32, 5 * i as u32 + 4))
            .collect();
        let cases: Vec<(String, Vec<String>, bool, Vec<(String, u32, u32)>)> = vec![
            (
                "hello world hello".to_string(),
                vec!["hello".to_string()],
                true,
                vec![
                    ("hello".to_string(), 0, 5),
                    ("hello".to_string(), 12, 17),
                ],
            ),
            (
                "Hello WORLD".to_string(),
                vec!["hello".to_string(), "world".to_string()],
                true,
                vec![
                    ("Hello".to_string(), 0, 5),
                    ("WORLD".to_string(), 6, 11),
                ],
            ),
            (
                capped_content,
                vec!["word".to_string()],
                true,
                capped_expected,
            ),
            ("hello world".to_string(), vec![], true, vec![]),
            ("".to_string(), vec!["hello".to_string()], true, vec![]),
            (
                "hello world".to_string(),
                vec!["xyz".to_string()],
                true,
                vec![],
            ),
            (
                "café résumé".to_string(),
                vec!["cafe".to_string(), "resume".to_string()],
                true,
                vec![
                    ("café".to_string(), 0, 4),
                    ("résumé".to_string(), 5, 11),
                ],
            ),
            (
                "x e\u{301} 😀".to_string(),
                vec!["e".to_string()],
                true,
                vec![("e\u{301}".to_string(), 2, 4)],
            ),
            (
                "hello world".to_string(),
                vec!["hello".to_string()],
                true,
                vec![("hello".to_string(), 0, 5)],
            ),
            (
                "世界hello".to_string(),
                vec!["hello".to_string()],
                false,
                vec![("hello".to_string(), 2, 7)],
            ),
            (
                "😀hello".to_string(),
                vec!["hello".to_string()],
                false,
                vec![("hello".to_string(), 2, 7)],
            ),
            (
                "the quick brown fox".to_string(),
                vec!["quick".to_string(), "fox".to_string()],
                false,
                vec![
                    ("quick".to_string(), 4, 9),
                    ("fox".to_string(), 16, 19),
                ],
            ),
        ];
        for (content, terms, ignore_diacritics, expected) in cases {
            let actual = extract(&content, &terms, ignore_diacritics)
                .iter()
                .map(|matched| {
                    (
                        matched.match_text.clone(),
                        matched.range.start(),
                        matched.range.end(),
                    )
                })
                .collect::<Vec<_>>();
            assert_eq!(actual, expected, "content: {content:?}");
        }
    }




}
