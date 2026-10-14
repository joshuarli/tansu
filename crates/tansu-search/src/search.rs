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
    ExcerptRange, FieldScoreBreakdown, Fuzziness, NoteRange, SearchMode,
    SearchOptions, SearchResult,
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
    if query.len() > MAX_QUERY_BYTES {
        return Err(SearchError::QueryTooLong {
            bytes: query.len(),
            maximum: MAX_QUERY_BYTES,
        });
    }
    let query = query.trim();
    if query.is_empty() || options.limit.get() == 0 {
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
                &TopDocs::with_limit(options.limit.get()).order_by_score(),
            )?,
            options.fuzziness,
        )
    } else {
        let exact_query = build_search_query(index, &parsed, options, Fuzziness::Disabled, false);
        let search_limit = options.limit.get().max(FUZZY_THRESHOLD);
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
    results.truncate(options.limit.get());
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
                    let boost = field_weight(name);
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
                        if term.len() >= options.prefix_length.get() {
                            queries.push((
                                Occur::Should,
                                Box::new(BoostQuery::new(
                                    Box::new(PhrasePrefixQuery::new(vec![exact_term.clone()])),
                                    boost * 0.8,
                                )),
                            ));
                        }
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
                let boost = field_weight(name);
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
    let field_scores = options.score_breakdown.then(|| {
        field_scores(
            index,
            &document,
            terms,
            fuzziness,
            options.mode == SearchMode::TypoOnly,
        )
    });
    Ok(Some(SearchResult {
        note_id,
        revision,
        source_hash,
        title,
        path,
        score,
        field_scores,
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

fn field_scores(
    index: &IndexManager,
    doc: &TantivyDocument,
    terms: &[String],
    fuzziness: Fuzziness,
    fuzzy_only: bool,
) -> FieldScoreBreakdown {
    let mut scores = FieldScoreBreakdown::default();
    for (name, field) in index.fields().text_fields() {
        let text = doc_text(doc, field);
        let field_terms = tokenize_query_text(&text)
            .into_iter()
            .map(|(_, term)| term)
            .collect::<Vec<_>>();
        let matched = terms
            .iter()
            .filter(|term| {
                let term: &String = term;
                let exact = field_terms.iter().any(|word| word == term);
                if fuzzy_only {
                    exact
                        || !find_fuzzy_matches(&text, std::slice::from_ref(term), fuzziness)
                            .is_empty()
                } else {
                    exact || field_terms
                        .iter()
                        .any(|word| word.starts_with(&term[..]))
                }
            })
            .count() as f32;
        let score = matched * field_weight(name);
        match name {
            "title" => scores.title = score,
            "path" => scores.path = score,
            "headings" => scores.headings = score,
            "tags" => scores.tags = score,
            "content" => scores.content = score,
            _ => unreachable!(),
        }
    }
    scores
}

fn field_weight(name: &str) -> f32 {
    match name {
        "title" => 10.0,
        "path" => 7.0,
        "headings" => 5.0,
        "tags" => 2.0,
        "content" => 1.0,
        _ => 0.0,
    }
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
            format!("sha256-v2:{revision}"),
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
    fn basic_search() {
        let index = setup_index(vec![doc("a", "hello world")]);
        assert_eq!(results(&index, "hello", options())[0].note_id, "a");
    }

    #[test]
    fn multi_term_search() {
        let index = setup_index(vec![doc("a", "hello world"), doc("b", "hello only")]);
        let hits = results(&index, "hello world", options());
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note_id, "a");
    }

    #[test]
    fn empty_query() {
        let index = setup_index(vec![doc("a", "hello world")]);
        assert!(results(&index, "", options()).is_empty());
    }

    #[test]
    fn single_file_filter() {
        let index = setup_index(vec![doc("one", "alpha"), doc("two", "alpha")]);
        assert!(index.has_document("one").unwrap());
        assert!(!index.has_document("missing").unwrap());
    }

    #[test]
    fn display_title_boost() {
        let index = setup_index(vec![
            make_doc("body", "body.md", "other", "search", "", &[], 1),
            make_doc("title", "title.md", "search", "other", "", &[], 1),
        ]);
        assert_eq!(results(&index, "search", options())[0].note_id, "title");
    }

    #[test]
    fn fuzzy_search() {
        let index = setup_index(vec![doc("typo", "pwoder")]);
        let hits = results(
            &index,
            "powder",
            SearchOptions {
                fuzziness: Fuzziness::OneEdit,
                ..options()
            },
        );
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn tags_in_result() {
        let index = setup_index(vec![make_doc("a", "a.md", "a", "body", "", &["cooking"], 1)]);
        assert_eq!(results(&index, "cooking", options())[0].note_id, "a");
    }

    #[test]
    fn search_returns_stored_fields() {
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
        assert_eq!(hit.source_hash, "sha256-v2:7");
        assert!(!hit.excerpt.is_empty());
    }

    #[test]
    fn fuzzy_distance_values() {
        assert_eq!(Fuzziness::OneEdit.distance_for("cat"), 0);
        assert_eq!(Fuzziness::OneEdit.distance_for("tacos"), 1);
        assert_eq!(Fuzziness::TwoEdits.distance_for("tacoshop"), 2);
    }

    #[test]
    fn whitespace_only_query() {
        let index = setup_index(vec![doc("a", "hello world")]);
        assert!(results(&index, " \t\n ", options()).is_empty());
    }

    #[test]
    fn osa_distance_values() {
        assert_eq!(osa_distance("powder", "powder"), 0);
        assert_eq!(osa_distance("powder", "pwoder"), 1);
        assert_eq!(osa_distance("powder", "powdr"), 1);
        assert_eq!(osa_distance("powder", "poweder"), 1);
    }

    #[test]
    fn fuzziness_zero_no_fuzzy() {
        let index = setup_index(vec![doc("typo", "pwoder")]);
        assert!(results(&index, "powder", options()).is_empty());
    }

    #[test]
    fn fuzziness2_finds_pwoder() {
        let index = setup_index(vec![doc("typo", "pwoder")]);
        let hits = results(
            &index,
            "powder",
            SearchOptions {
                fuzziness: Fuzziness::TwoEdits,
                ..options()
            },
        );
        assert_eq!(hits[0].note_id, "typo");
    }

    #[test]
    fn fuzziness2_matches_both_exact_and_fuzzy() {
        let index = setup_index(vec![doc("exact", "powder"), doc("typo", "pwoder")]);
        let hits = results(
            &index,
            "powder",
            SearchOptions {
                fuzziness: Fuzziness::TwoEdits,
                limit: SearchLimit::try_from(2).unwrap(),
                ..options()
            },
        );
        assert!(hits.iter().any(|hit| hit.note_id == "exact"));
        assert!(hits.iter().any(|hit| hit.note_id == "typo"));
    }

    #[test]
    fn fuzzy_only_matches_typo() {
        let index = setup_index(vec![doc("typo", "pwoder")]);
        let hits = results(
            &index,
            "powder",
            SearchOptions {
                mode: SearchMode::TypoOnly,
                fuzziness: Fuzziness::TwoEdits,
                ..options()
            },
        );
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note_id, "typo");
        assert!(hits[0].source_reveal_range.is_some());
    }

    #[test]
    fn typo_only_search_matches_a_typo_in_the_path_without_source_ranges() {
        let index = setup_index(vec![make_doc(
            "typo-path",
            "pwoder.md",
            "Recipe",
            "body only",
            "",
            &[],
            1,
        )]);
        let hits = results(
            &index,
            "powder",
            SearchOptions {
                mode: SearchMode::TypoOnly,
                fuzziness: Fuzziness::OneEdit,
                ..options()
            },
        );
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "pwoder.md");
        assert!(hits[0].source_reveal_range.is_none());
        assert!(hits[0].excerpt_ranges.is_empty());
    }

    #[test]
    fn typo_only_does_not_search_phrase_words_fuzzily() {
        let index = setup_index(vec![doc("typo", "pwoder milk")]);
        let hits = results(
            &index,
            "\"powder milk\"",
            SearchOptions {
                mode: SearchMode::TypoOnly,
                fuzziness: Fuzziness::TwoEdits,
                ..options()
            },
        );
        assert!(hits.is_empty());
    }

    #[test]
    fn fuzzy_only_finds_typo_in_mixed_doc() {
        let index = setup_index(vec![doc("mixed", "powder pwoder")]);
        let hits = results(
            &index,
            "powder",
            SearchOptions {
                mode: SearchMode::TypoOnly,
                fuzziness: Fuzziness::TwoEdits,
                ..options()
            },
        );
        assert_eq!(hits.len(), 1);
        assert!(!hits[0].excerpt_ranges.is_empty());
    }

    #[test]
    fn fuzzy_only_matches_both_docs() {
        let index = setup_index(vec![doc("exact", "powder"), doc("typo", "pwoder")]);
        let hits = results(
            &index,
            "powder",
            SearchOptions {
                mode: SearchMode::TypoOnly,
                fuzziness: Fuzziness::TwoEdits,
                ..options()
            },
        );
        assert_eq!(hits.iter().map(|hit| hit.note_id.as_str()).collect::<Vec<_>>(), ["typo"]);
    }

    #[test]
    fn fuzzy_only_skips_short_terms() {
        let index = setup_index(vec![doc("a", "fox")]);
        let hits = results(
            &index,
            "fox",
            SearchOptions {
                mode: SearchMode::TypoOnly,
                fuzziness: Fuzziness::TwoEdits,
                ..options()
            },
        );
        assert!(hits.is_empty());
    }

    #[test]
    fn typed_options_keep_recency_out_of_search_state() {
        assert_eq!(SearchOptions::default().mode, SearchMode::ExactPrefix);
        assert_eq!(SearchOptions::default().fuzziness, Fuzziness::OneEdit);
    }

    #[test]
    fn matched_terms_lowercased() {
        let index = setup_index(vec![doc("a", "Hello World")]);
        let hit = &results(&index, "Hello World", options())[0];
        assert_eq!(hit.matched_terms, ["hello", "world"]);
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
            assert_eq!(field_weight(field), weight);
        }
    }

    #[test]
    fn headings_search() {
        let index = setup_index(vec![make_doc("a", "a.md", "a", "body", "Important Heading", &[], 1)]);
        assert_eq!(results(&index, "important", options())[0].note_id, "a");
    }

    #[test]
    fn disabled_fields_not_searched() {
        let index = setup_index(vec![make_doc(
            "a",
            "a.md",
            "a",
            "body text",
            "",
            &[],
            1,
        )]);
        assert!(results(&index, "nickname", options()).is_empty());
        assert!(results(&index, "programming", options()).is_empty());
    }

    #[test]
    fn limit_results() {
        let docs = (0..10).map(|i| doc(&i.to_string(), "common search term")).collect();
        let index = setup_index(docs);
        let options = SearchOptions {
            limit: SearchLimit::try_from(3).unwrap(),
            ..self::options()
        };
        assert_eq!(results(&index, "common", options).len(), 3);
    }

    #[test]
    fn sparse_fallback_threshold_is_independent_of_output_limit() {
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
    fn prefix_search() {
        let index = setup_index(vec![doc("a", "internationalization is important")]);
        assert_eq!(results(&index, "intern", options())[0].note_id, "a");
    }

    #[test]
    fn no_results_for_nonexistent() {
        let index = setup_index(vec![doc("a", "hello world")]);
        assert!(results(&index, "xyzzynonexistent", options()).is_empty());
    }

    #[test]
    fn single_char_query() {
        let index = setup_index(vec![doc("a", "x marks the spot")]);
        assert_eq!(results(&index, "x", options()).len(), 1);
    }

    #[test]
    fn phrase_basic_match() {
        let index = setup_index(vec![doc("a", "the quick brown fox"), doc("b", "brown quick fox")]);
        let hits = results(&index, "\"quick brown\"", options());
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note_id, "a");
    }

    #[test]
    fn phrase_no_match_reversed() {
        let index = setup_index(vec![doc("a", "the brown quick fox")]);
        assert!(results(&index, "\"quick brown\"", options()).is_empty());
    }

    #[test]
    fn phrase_no_match_non_adjacent() {
        let index = setup_index(vec![doc("a", "quick red brown fox")]);
        assert!(results(&index, "\"quick brown\"", options()).is_empty());
    }

    #[test]
    fn phrase_with_extra_terms() {
        let index = setup_index(vec![
            doc("a", "quick brown fox lazy dog"),
            doc("b", "lazy dog sleeps"),
        ]);
        let hits = results(&index, "\"quick brown\" lazy", options());
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note_id, "a");
    }

    #[test]
    fn single_word_phrase_as_term() {
        let index = setup_index(vec![doc("a", "hello world")]);
        assert_eq!(results(&index, "\"hello\"", options()).len(), 1);
    }

    #[test]
    fn multiple_phrases() {
        let index = setup_index(vec![
            doc("a", "quick brown fox and lazy dog"),
            doc("b", "quick brown fox and busy cat"),
        ]);
        let hits = results(&index, "\"quick brown\" \"lazy dog\"", options());
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note_id, "a");
    }

    #[test]
    fn empty_phrase_ignored() {
        let index = setup_index(vec![doc("a", "hello world")]);
        assert!(results(&index, "\"\"", options()).is_empty());
    }

    #[test]
    fn unclosed_quote_as_terms() {
        let index = setup_index(vec![doc("a", "hello beautiful world")]);
        assert_eq!(results(&index, "\"hello world", options()).len(), 1);
    }

    #[test]
    fn phrase_in_headings() {
        let index = setup_index(vec![make_doc("a", "a.md", "a", "body", "quick brown fox", &[], 1)]);
        assert_eq!(results(&index, "\"quick brown\"", options()).len(), 1);
    }

    #[test]
    fn phrase_across_camel_case_boundary() {
        let index = setup_index(vec![doc("a", "myVariable is great")]);
        assert_eq!(results(&index, "\"variable is\"", options()).len(), 1);
    }

    #[test]
    fn phrase_matched_terms_include_phrase_words() {
        let index = setup_index(vec![doc("a", "quick brown fox")]);
        let hit = &results(&index, "\"quick brown\" fox", options())[0];
        assert!(hit.matched_terms.contains(&"quick".into()));
        assert!(hit.matched_terms.contains(&"brown".into()));
        assert!(hit.matched_terms.contains(&"fox".into()));
    }

    #[test]
    fn parse_query_simple_terms() {
        let parsed = parse_query("hello world");
        assert_eq!(parsed.terms, ["hello", "world"]);
        assert!(parsed.phrases.is_empty());
    }

    #[test]
    fn parse_query_single_phrase() {
        let parsed = parse_query("\"quick brown\"");
        assert!(parsed.terms.is_empty());
        assert_eq!(parsed.phrases, [vec!["quick", "brown"]]);
    }

    #[test]
    fn parse_query_phrase_and_terms() {
        let parsed = parse_query("hello \"quick brown\" world");
        assert_eq!(parsed.terms, ["hello", "world"]);
        assert_eq!(parsed.phrases, [vec!["quick", "brown"]]);
    }

    #[test]
    fn parse_query_single_word_phrase_promoted() {
        let parsed = parse_query("\"hello\"");
        assert_eq!(parsed.terms, ["hello"]);
        assert!(parsed.phrases.is_empty());
    }

    #[test]
    fn parse_query_empty_phrase_ignored() {
        let parsed = parse_query("\"\"");
        assert!(parsed.terms.is_empty());
        assert!(parsed.phrases.is_empty());
    }

    #[test]
    fn parse_query_unclosed_quote() {
        let parsed = parse_query("\"hello world");
        assert_eq!(parsed.terms, ["hello", "world"]);
        assert!(parsed.phrases.is_empty());
    }

    #[test]
    fn parse_query_multiple_phrases() {
        let parsed = parse_query("\"foo bar\" \"baz qux\"");
        assert!(parsed.terms.is_empty());
        assert_eq!(parsed.phrases, [vec!["foo", "bar"], vec!["baz", "qux"]]);
    }

    #[test]
    fn parse_query_lowercases() {
        let parsed = parse_query("Hello \"FOO Bar\"");
        assert_eq!(parsed.terms, ["hello"]);
        assert_eq!(parsed.phrases, [vec!["foo", "bar"]]);
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
    fn find_matches_basic() {
        let matches = extract("hello world hello", &["hello".into()], true);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].match_text, "hello");
        assert_eq!(matches[0].range.start(), 0);
        assert_eq!(matches[1].range.start(), 12);
    }

    #[test]
    fn find_matches_case_insensitive() {
        let matches = extract("Hello WORLD", &["hello".into(), "world".into()], true);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].match_text, "Hello");
        assert_eq!(matches[1].match_text, "WORLD");
    }

    #[test]
    fn find_matches_cap_at_100() {
        let content = "word ".repeat(200);
        assert_eq!(extract(&content, &["word".into()], true).len(), MAX_MATCHES);
    }

    #[test]
    fn find_matches_empty_terms() {
        assert!(extract("hello world", &[], true).is_empty());
    }

    #[test]
    fn find_matches_empty_content() {
        assert!(extract("", &["hello".into()], true).is_empty());
    }

    #[test]
    fn find_matches_no_match() {
        assert!(extract("hello world", &["xyz".into()], true).is_empty());
    }

    #[test]
    fn find_matches_diacritics() {
        let matches = extract("café résumé", &["cafe".into(), "resume".into()], true);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].match_text, "café");
        assert_eq!(matches[1].match_text, "résumé");
    }

    #[test]
    fn find_matches_combining_mark_preserves_source_offsets() {
        let matches = extract("x e\u{301} 😀", &["e".into()], true);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].match_text, "e\u{301}");
        assert_eq!((matches[0].range.start(), matches[0].range.end()), (2, 4));
    }

    #[test]
    fn find_matches_ascii_skips_diacritics() {
        assert_eq!(extract("hello world", &["hello".into()], true).len(), 1);
    }

    #[test]
    fn find_matches_utf16_offsets() {
        let matches = extract("世界hello", &["hello".into()], false);
        assert_eq!((matches[0].range.start(), matches[0].range.end()), (2, 7));
    }

    #[test]
    fn find_matches_emoji_utf16_offsets() {
        let matches = extract("😀hello", &["hello".into()], false);
        assert_eq!(matches[0].range.start(), 2);
    }

    #[test]
    fn find_matches_multiple_terms() {
        let matches = extract("the quick brown fox", &["quick".into(), "fox".into()], false);
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0].range.start(), 4);
        assert_eq!(matches[1].range.start(), 16);
    }

    #[test]
    fn search_returns_matches() {
        let index = setup_index(vec![doc("a", "Hello world, this is a test document")]);
        let hits = results(&index, "hello test", options());
        assert_eq!(hits[0].excerpt_ranges.len(), 2);
    }

    #[test]
    fn score_breakdown_disabled_by_default() {
        let index = setup_index(vec![doc("a", "hello world")]);
        assert!(results(&index, "hello", options())[0].field_scores.is_none());
    }

    #[test]
    fn score_breakdown_returns_field_scores() {
        let index = setup_index(vec![make_doc(
            "a",
            "notes/hello.md",
            "hello",
            "hello body",
            "",
            &[],
            1,
        )]);
        let hits = results(
            &index,
            "hello",
            SearchOptions {
                score_breakdown: true,
                ..options()
            },
        );
        let fields = hits[0].field_scores.as_ref().unwrap();
        assert!(fields.title > 0.0);
        assert!(fields.path > 0.0);
        assert!(fields.content > 0.0);
    }

    #[test]
    fn score_breakdown_headings_field() {
        let index = setup_index(vec![make_doc("a", "a.md", "a", "body", "Important Topic", &[], 1)]);
        let fields = results(
            &index,
            "important",
            SearchOptions {
                score_breakdown: true,
                ..options()
            },
        )[0]
            .field_scores
            .as_ref()
            .unwrap()
            .clone();
        assert!(fields.headings > 0.0);
        assert_eq!(fields.title, 0.0);
    }

    #[test]
    fn score_breakdown_directory_field() {
        let index = setup_index(vec![doc("a", "body")]);
        assert_eq!(field_weight("path"), 7.0);
        assert_eq!(index.document_count(), 1);
    }

    #[test]
    fn query_limit_returns_a_typed_error() {
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
    fn excerpt_is_bounded_and_filename_only_has_no_offset() {
        let long = format!("{}needle{}", "before ".repeat(100), " after".repeat(100));
        let index = setup_index(vec![doc("long", &long), doc("filename", "other")]);
        let hit = results(&index, "needle", options()).remove(0);
        assert!(hit.excerpt.len() <= MAX_EXCERPT_BYTES);
        assert!(hit.source_reveal_range.is_some());
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
    }

    #[test]
    fn combining_marks_tabs_frontmatter_and_repeated_text_keep_source_offsets() {
        let content = "---\ntags: [one]\n---\n\te\u{301} 😀 needle needle";
        let index = setup_index(vec![make_doc(
            "a",
            "a.md",
            "a",
            content,
            "",
            &["one"],
            1,
        )]);
        let hit = results(&index, "needle", options()).remove(0);
        assert_eq!(hit.source_reveal_range.as_ref().unwrap().start(), 27);
        assert_eq!(hit.excerpt_ranges.len(), 2);
    }
}
