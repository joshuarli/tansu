use std::{
    fs,
    path::Path,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use tantivy::{
    DocAddress, Index as TantivyIndex, IndexReader, IndexWriter, TantivyDocument,
    collector::TopDocs,
    query::{
        BooleanQuery, FuzzyTermQuery, Occur, PhrasePrefixQuery, PhraseQuery, Query, TermQuery,
    },
    schema::*,
};

use crate::util::StrExt;
use crate::{http, scanner, strip, tags::TagStore, util};

#[derive(Clone)]
pub struct NoteEntry {
    pub path: String,
    pub title: String,
    pub tags: Vec<String>,
}

pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub tags: Vec<String>,
    pub excerpt: String,
    pub score: f32,
    pub mtime: u64,
    pub recency_multiplier: f32,
    pub field_scores: FieldScores,
}

#[derive(Clone, Copy, Debug)]
pub struct SearchWeights {
    pub title: f32,
    pub headings: f32,
    pub tags: f32,
    pub content: f32,
}

#[derive(Default)]
pub struct FieldScores {
    pub title: f32,
    pub headings: f32,
    pub tags: f32,
    pub content: f32,
}

struct Fields {
    path: Field,
    title: Field,
    content: Field,
    headings: Field,
    tags: Field,
    mtime: Field,
    links_to: Field,
}

#[derive(Clone)]
pub struct Index {
    inner: Arc<IndexInner>,
}

struct IndexInner {
    writer: RwLock<IndexWriter>,
    reader: IndexReader,
    fields: Fields,
    dirty: AtomicBool,
    uncommitted: AtomicBool,
    notes_cache: Mutex<Option<Vec<NoteEntry>>>,
}

struct ParsedQuery {
    terms: Vec<String>,
    phrases: Vec<Vec<String>>,
}

impl Index {
    pub fn open_or_create(path: &Path) -> tantivy::Result<Self> {
        let mut schema_builder = Schema::builder();
        let path_field = schema_builder.add_text_field("path", STRING | STORED);
        let title = schema_builder.add_text_field("title", TEXT | STORED);
        let content = schema_builder.add_text_field(
            "content",
            TextOptions::default()
                .set_indexing_options(
                    TextFieldIndexing::default()
                        .set_tokenizer("default")
                        .set_index_option(IndexRecordOption::WithFreqsAndPositions),
                )
                .set_stored(),
        );
        let headings = schema_builder.add_text_field("headings", TEXT | STORED);
        let tags = schema_builder.add_text_field("tags", TEXT | STORED);
        let mtime = schema_builder.add_u64_field("mtime", STORED | FAST);
        let links_to = schema_builder.add_text_field("links_to", TEXT | STORED);
        let schema = schema_builder.build();

        let index = if path.join("meta.json").exists() {
            TantivyIndex::open_in_dir(path)?
        } else {
            TantivyIndex::create_in_dir(path, schema)?
        };

        let writer = index.writer(50_000_000)?;
        let reader = index.reader()?;

        Ok(Index {
            inner: Arc::new(IndexInner {
                writer: RwLock::new(writer),
                reader,
                fields: Fields {
                    path: path_field,
                    title,
                    content,
                    headings,
                    tags,
                    mtime,
                    links_to,
                },
                dirty: AtomicBool::new(true),
                uncommitted: AtomicBool::new(false),
                notes_cache: Mutex::new(None),
            }),
        })
    }

    /// Build and add a document to the writer (does not commit).
    fn add_doc(&self, rel_path: &str, content: &str, full_path: &Path, tags: &[String]) {
        let f = &self.inner.fields;
        let scan = scanner::scan(content);
        let stripped = strip::strip_markdown(content);
        let mtime = http::mtime_secs(full_path);

        let title = Path::new(rel_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(rel_path)
            .to_string();

        let writer = self.inner.writer.write().unwrap();
        let path_term = tantivy::Term::from_field_text(f.path, rel_path);
        writer.delete_term(path_term);

        let mut doc = TantivyDocument::new();
        doc.add_text(f.path, rel_path);
        doc.add_text(f.title, &title);
        doc.add_text(f.content, &stripped);
        doc.add_text(f.headings, scan.headings.join(" "));
        for tag in tags {
            doc.add_text(f.tags, tag);
        }
        doc.add_u64(f.mtime, mtime);
        doc.add_text(f.links_to, scan.links.join(" "));

        let _ = writer.add_document(doc);
    }

    pub fn commit(&self) {
        let mut writer = self.inner.writer.write().unwrap();
        let _ = writer.commit();
        self.inner.dirty.store(true, Ordering::Release);
        self.inner.uncommitted.store(false, Ordering::Release);
        *self.inner.notes_cache.lock().unwrap() = None;
    }

    /// Commit only if there are uncommitted writes.
    fn ensure_committed(&self) {
        if self.inner.uncommitted.swap(false, Ordering::AcqRel) {
            let mut writer = self.inner.writer.write().unwrap();
            let _ = writer.commit();
            self.inner.dirty.store(true, Ordering::Release);
            *self.inner.notes_cache.lock().unwrap() = None;
        }
    }

    /// Reload the reader only if the index has been committed to since last reload.
    fn reload_if_dirty(&self) {
        if self.inner.dirty.swap(false, Ordering::AcqRel) {
            let _ = self.inner.reader.reload();
        }
    }

    /// Index a single note. Commit is deferred until the next read operation.
    pub fn index_note(&self, rel_path: &str, content: &str, full_path: &Path, tags: &[String]) {
        self.add_doc(rel_path, content, full_path, tags);
        self.inner.uncommitted.store(true, Ordering::Release);
        *self.inner.notes_cache.lock().unwrap() = None;
    }

    pub fn remove_note(&self, rel_path: &str) {
        let writer = self.inner.writer.write().unwrap();
        let path_term = tantivy::Term::from_field_text(self.inner.fields.path, rel_path);
        writer.delete_term(path_term);
        drop(writer);
        self.inner.uncommitted.store(true, Ordering::Release);
        *self.inner.notes_cache.lock().unwrap() = None;
    }

    /// Two-phase search: exact + prefix first, fuzzy fallback if <5 results.
    /// `weights` order: [title, headings, tags, content].
    pub fn search(
        &self,
        query: &str,
        limit: usize,
        filter_path: Option<&str>,
        fuzzy_distance: u8,
        recency_boost: u8,
        weights: SearchWeights,
        score_breakdown: bool,
    ) -> Vec<SearchResult> {
        self.ensure_committed();
        self.reload_if_dirty();
        let searcher = self.inner.reader.searcher();

        let parsed = parse_query(query);
        if parsed.terms.is_empty() && parsed.phrases.is_empty() {
            return Vec::new();
        }

        // Phase 1: exact + prefix + phrase
        let phase1_query = self.build_query(&parsed, false, filter_path, fuzzy_distance, weights);
        let results = self.execute_search(
            &searcher,
            &phase1_query,
            limit,
            &parsed.terms,
            &parsed.phrases,
            false,
            fuzzy_distance,
            recency_boost,
            weights,
            score_breakdown,
        );

        if results.len() >= 5 {
            return results;
        }

        // Phase 2: add fuzzy
        let phase2_query = self.build_query(&parsed, true, filter_path, fuzzy_distance, weights);
        self.execute_search(
            &searcher,
            &phase2_query,
            limit,
            &parsed.terms,
            &parsed.phrases,
            true,
            fuzzy_distance,
            recency_boost,
            weights,
            score_breakdown,
        )
    }

    fn build_query(
        &self,
        parsed: &ParsedQuery,
        fuzzy: bool,
        filter_path: Option<&str>,
        fuzzy_distance: u8,
        weights: SearchWeights,
    ) -> BooleanQuery {
        let f = &self.inner.fields;
        let search_fields = [
            (f.title, weights.title),
            (f.headings, weights.headings),
            (f.tags, weights.tags),
            (f.content, weights.content),
        ];

        let mut term_queries: Vec<(Occur, Box<dyn tantivy::query::Query>)> = Vec::new();

        for word in &parsed.terms {
            let mut field_queries: Vec<(Occur, Box<dyn tantivy::query::Query>)> = Vec::new();

            for &(field, boost) in &search_fields {
                let term = tantivy::Term::from_field_text(field, word);

                let exact = TermQuery::new(term.clone(), IndexRecordOption::WithFreqs);
                field_queries.push((
                    Occur::Should,
                    Box::new(tantivy::query::BoostQuery::new(Box::new(exact), boost)),
                ));

                let prefix = PhrasePrefixQuery::new(vec![term.clone()]);
                field_queries.push((
                    Occur::Should,
                    Box::new(tantivy::query::BoostQuery::new(
                        Box::new(prefix),
                        boost * 0.8,
                    )),
                ));

                if fuzzy && fuzzy_distance > 0 && field == f.content {
                    let fuzzy_q = FuzzyTermQuery::new(term, fuzzy_distance, true);
                    field_queries.push((
                        Occur::Should,
                        Box::new(tantivy::query::BoostQuery::new(
                            Box::new(fuzzy_q),
                            boost * 0.6,
                        )),
                    ));
                }
            }

            let word_query = BooleanQuery::new(field_queries);
            term_queries.push((Occur::Must, Box::new(word_query)));
        }

        for phrase_words in &parsed.phrases {
            let mut field_queries: Vec<(Occur, Box<dyn tantivy::query::Query>)> = Vec::new();
            for &(field, boost) in &search_fields {
                let phrase_terms = phrase_words
                    .iter()
                    .map(|word| tantivy::Term::from_field_text(field, word))
                    .collect();
                let phrase = PhraseQuery::new(phrase_terms);
                field_queries.push((
                    Occur::Should,
                    Box::new(tantivy::query::BoostQuery::new(Box::new(phrase), boost)),
                ));
            }
            term_queries.push((Occur::Must, Box::new(BooleanQuery::new(field_queries))));
        }

        if let Some(path) = filter_path {
            let path_term = tantivy::Term::from_field_text(f.path, path);
            let path_query = TermQuery::new(path_term, IndexRecordOption::Basic);
            term_queries.push((Occur::Must, Box::new(path_query)));
        }

        BooleanQuery::new(term_queries)
    }

    fn execute_search(
        &self,
        searcher: &tantivy::Searcher,
        query: &BooleanQuery,
        limit: usize,
        terms: &[String],
        phrases: &[Vec<String>],
        fuzzy: bool,
        fuzzy_distance: u8,
        recency_boost: u8,
        weights: SearchWeights,
        score_breakdown: bool,
    ) -> Vec<SearchResult> {
        let f = &self.inner.fields;
        let Ok(top_docs) = searcher.search(query, &TopDocs::with_limit(limit)) else {
            return Vec::new();
        };
        let recency_decay = match recency_boost {
            1 => Some(-3.0_f32),
            2 => Some(-0.3_f32),
            3 => Some(-0.1_f32),
            _ => None,
        };
        let now = now_epoch_secs();

        // Pre-lowercase terms as bytes once for all results
        let lower_terms: Vec<Vec<u8>> = terms
            .iter()
            .map(|t| t.bytes().map(|b| b.to_ascii_lowercase()).collect())
            .collect();
        let term_refs: Vec<&[u8]> = lower_terms.iter().map(|t| t.as_slice()).collect();
        let lower_phrases: Vec<Vec<Vec<u8>>> = phrases
            .iter()
            .map(|phrase| {
                phrase
                    .iter()
                    .map(|word| word.bytes().map(|b| b.to_ascii_lowercase()).collect())
                    .collect()
            })
            .collect();
        let phrase_refs: Vec<Vec<&[u8]>> = lower_phrases
            .iter()
            .map(|phrase| phrase.iter().map(|word| word.as_slice()).collect())
            .collect();

        let mut results = Vec::with_capacity(top_docs.len());
        for (score, doc_address) in top_docs {
            let Ok(doc) = searcher.doc::<TantivyDocument>(doc_address) else {
                continue;
            };
            let path = doc
                .get_first(f.path)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let title = doc
                .get_first(f.title)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mtime = doc.get_first(f.mtime).and_then(|v| v.as_u64()).unwrap_or(0);
            let content = doc
                .get_first(f.content)
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let tags = doc
                .get_all(f.tags)
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect();
            let excerpt = make_snippet(content, &term_refs, &phrase_refs, 160);

            let field_scores = if score_breakdown {
                explain_field_scores(
                    searcher,
                    doc_address,
                    f,
                    terms,
                    phrases,
                    fuzzy,
                    fuzzy_distance,
                    weights,
                )
            } else {
                FieldScores::default()
            };
            let recency_multiplier = recency_decay
                .map(|decay| {
                    let days = (now.saturating_sub(mtime) as f32) / (24.0 * 3600.0);
                    1.0 + (decay * days / 1000.0).exp()
                })
                .unwrap_or(1.0);

            results.push(SearchResult {
                path,
                title,
                tags,
                excerpt,
                score: score * recency_multiplier,
                mtime,
                recency_multiplier,
                field_scores,
            });
        }
        if recency_decay.is_some() {
            results.sort_by(|a, b| b.score.total_cmp(&a.score));
        }
        results
    }

    pub fn get_backlinks(&self, target_stem: &str) -> Vec<String> {
        self.ensure_committed();
        self.reload_if_dirty();
        let searcher = self.inner.reader.searcher();
        let f = &self.inner.fields;

        let term = tantivy::Term::from_field_text(f.links_to, &target_stem.to_lowercase());
        let query = TermQuery::new(term, IndexRecordOption::WithFreqs);

        let Ok(top_docs) = searcher.search(&query, &TopDocs::with_limit(100)) else {
            return Vec::new();
        };

        top_docs
            .into_iter()
            .filter_map(|(_, addr)| {
                let doc = searcher.doc::<TantivyDocument>(addr).ok()?;
                doc.get_first(f.path)
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .collect()
    }

    pub fn get_all_notes(&self) -> Vec<NoteEntry> {
        self.ensure_committed();
        self.reload_if_dirty();

        {
            let cache = self.inner.notes_cache.lock().unwrap();
            if let Some(ref notes) = *cache {
                return notes.clone();
            }
        }

        let searcher = self.inner.reader.searcher();
        let f = &self.inner.fields;

        let mut notes = Vec::new();
        for segment_reader in searcher.segment_readers() {
            let Ok(store_reader) = segment_reader.get_store_reader(64) else {
                continue;
            };
            // alive_bitset() is None when no docs in this segment are deleted.
            // Must use max_doc() (not num_docs()) as the upper bound: num_docs() is
            // the live count, but doc IDs are not compacted — iterating 0..num_docs()
            // visits deleted docs at low IDs and skips live docs at high IDs.
            let alive = segment_reader.alive_bitset();
            for doc_id in 0..segment_reader.max_doc() {
                if alive.is_some_and(|b| !b.is_alive(doc_id)) {
                    continue;
                }
                let Ok(doc) = store_reader.get::<TantivyDocument>(doc_id) else {
                    continue;
                };
                let path = doc
                    .get_first(f.path)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let title = doc
                    .get_first(f.title)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let tags = doc
                    .get_all(f.tags)
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect();
                if !path.is_empty() {
                    notes.push(NoteEntry { path, title, tags });
                }
            }
        }

        *self.inner.notes_cache.lock().unwrap() = Some(notes.clone());
        notes
    }
}

/// Compute per-field scores using Tantivy's explain API on each individual sub-query.
fn explain_field_scores(
    searcher: &tantivy::Searcher,
    addr: DocAddress,
    f: &Fields,
    terms: &[String],
    phrases: &[Vec<String>],
    fuzzy: bool,
    fuzzy_distance: u8,
    weights: SearchWeights,
) -> FieldScores {
    let fields = [
        (f.title, weights.title),
        (f.headings, weights.headings),
        (f.tags, weights.tags),
        (f.content, weights.content),
    ];
    let mut scores = [0.0f32; 4];

    for (i, &(field, boost)) in fields.iter().enumerate() {
        let mut field_score = 0.0f32;

        for word in terms {
            let term = tantivy::Term::from_field_text(field, word);

            let exact: Box<dyn Query> = Box::new(tantivy::query::BoostQuery::new(
                Box::new(TermQuery::new(term.clone(), IndexRecordOption::WithFreqs)),
                boost,
            ));
            if let Ok(expl) = exact.explain(searcher, addr) {
                field_score += expl.value();
            }

            let prefix: Box<dyn Query> = Box::new(tantivy::query::BoostQuery::new(
                Box::new(PhrasePrefixQuery::new(vec![term.clone()])),
                boost * 0.8,
            ));
            if let Ok(expl) = prefix.explain(searcher, addr) {
                field_score += expl.value();
            }

            if fuzzy && fuzzy_distance > 0 && field == f.content {
                let fuzzy_q: Box<dyn Query> = Box::new(tantivy::query::BoostQuery::new(
                    Box::new(FuzzyTermQuery::new(term, fuzzy_distance, true)),
                    boost * 0.6,
                ));
                if let Ok(expl) = fuzzy_q.explain(searcher, addr) {
                    field_score += expl.value();
                }
            }
        }

        for phrase_words in phrases {
            let phrase_terms = phrase_words
                .iter()
                .map(|word| tantivy::Term::from_field_text(field, word))
                .collect();
            let phrase: Box<dyn Query> = Box::new(tantivy::query::BoostQuery::new(
                Box::new(PhraseQuery::new(phrase_terms)),
                boost,
            ));
            if let Ok(expl) = phrase.explain(searcher, addr) {
                field_score += expl.value();
            }
        }

        scores[i] = field_score;
    }

    FieldScores {
        title: scores[0],
        headings: scores[1],
        tags: scores[2],
        content: scores[3],
    }
}

/// Build a snippet from content with highlighted query terms (supports fuzzy matching).
fn make_snippet(content: &str, terms: &[&[u8]], phrases: &[Vec<&[u8]>], max_len: usize) -> String {
    if content.is_empty() || terms.is_empty() {
        return String::new();
    }
    let phrase_mode = !phrases.is_empty();

    let phrase_match = phrases
        .iter()
        .find_map(|phrase| find_phrase_in_content(content, phrase));
    let first_match = phrase_match.or_else(|| {
        WordIter::new(content).find(|&(start, end)| {
            matches_any_term_for_snippet(&content.as_bytes()[start..end], terms, phrase_mode)
        })
    });

    let Some((first_start, _)) = first_match else {
        return escape_html(content.truncate_bytes(max_len));
    };

    // Pick window around the first match
    let window_start = content.floor_char_boundary(first_start.saturating_sub(40));
    let window_start = content[..window_start]
        .rfind(|c: char| c.is_whitespace())
        .map(|p| {
            let ch = content[p..].chars().next().unwrap();
            p + ch.len_utf8()
        })
        .unwrap_or(0);
    let window_end = content.floor_char_boundary((window_start + max_len).min(content.len()));
    let window_end = content[window_end..]
        .find(|c: char| c.is_whitespace())
        .map(|p| window_end + p)
        .unwrap_or(content.len());

    // Only scan words within the window
    let mut out = String::with_capacity(window_end - window_start + 64);
    let mut pos = window_start;
    for (ws, we) in WordIter::new(&content[window_start..window_end]) {
        let abs_start = window_start + ws;
        let abs_end = window_start + we;
        if matches_any_term_for_snippet(&content.as_bytes()[abs_start..abs_end], terms, phrase_mode)
        {
            if abs_start > pos {
                escape_html_into(&mut out, &content[pos..abs_start]);
            }
            out.push_str("<b>");
            escape_html_into(&mut out, &content[abs_start..abs_end]);
            out.push_str("</b>");
            pos = abs_end;
        }
    }
    if pos < window_end {
        escape_html_into(&mut out, &content[pos..window_end]);
    }

    out
}

fn find_phrase_in_content(content: &str, phrase: &[&[u8]]) -> Option<(usize, usize)> {
    if phrase.is_empty() {
        return None;
    }

    let words: Vec<(usize, usize)> = WordIter::new(content).collect();
    if words.len() < phrase.len() {
        return None;
    }

    for window in words.windows(phrase.len()) {
        let matches = window.iter().zip(phrase).all(|(&(start, end), term)| {
            ascii_eq_ignore_case(&content.as_bytes()[start..end], term)
        });
        if matches {
            return Some(window[0]);
        }
    }

    None
}

/// Zero-alloc word boundary iterator over ASCII alphanumeric words.
struct WordIter<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> WordIter<'a> {
    fn new(s: &'a str) -> Self {
        Self {
            bytes: s.as_bytes(),
            pos: 0,
        }
    }
}

fn parse_query(query: &str) -> ParsedQuery {
    let mut parsed = ParsedQuery {
        terms: Vec::new(),
        phrases: Vec::new(),
    };
    let mut buf = String::new();
    let mut in_quotes = false;

    for ch in query.chars() {
        if ch == '"' {
            if in_quotes {
                let phrase_terms = tokenize_query_text(&buf);
                if !phrase_terms.is_empty() {
                    parsed.terms.extend(phrase_terms.iter().cloned());
                    parsed.phrases.push(phrase_terms);
                }
            } else {
                parsed.terms.extend(tokenize_query_text(&buf));
            }
            buf.clear();
            in_quotes = !in_quotes;
            continue;
        }
        buf.push(ch);
    }

    parsed.terms.extend(tokenize_query_text(&buf));
    parsed
}

fn tokenize_query_text(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_lowercase())
        .collect()
}

impl Iterator for WordIter<'_> {
    type Item = (usize, usize);

    fn next(&mut self) -> Option<(usize, usize)> {
        while self.pos < self.bytes.len() && !self.bytes[self.pos].is_ascii_alphanumeric() {
            self.pos += 1;
        }
        if self.pos >= self.bytes.len() {
            return None;
        }
        let start = self.pos;
        while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_alphanumeric() {
            self.pos += 1;
        }
        Some((start, self.pos))
    }
}

/// Case-insensitive ASCII equality (zero alloc).
fn ascii_eq_ignore_case(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.eq_ignore_ascii_case(y))
}

/// Check if `word` begins with `prefix` (case-insensitive ASCII), excluding exact matches.
fn starts_with_ci(word: &[u8], prefix: &[u8]) -> bool {
    word.len() > prefix.len()
        && word
            .iter()
            .zip(prefix)
            .all(|(word, prefix)| word.eq_ignore_ascii_case(prefix))
}

/// Check if two byte slices have edit distance exactly 1 (case-insensitive ASCII).
fn edit_distance_one_ci(a: &[u8], b: &[u8]) -> bool {
    let (la, lb) = (a.len(), b.len());
    if la.abs_diff(lb) > 1 {
        return false;
    }
    if la == lb {
        let mut diffs = 0;
        for i in 0..la {
            if !a[i].eq_ignore_ascii_case(&b[i]) {
                diffs += 1;
                if diffs > 1 {
                    return false;
                }
            }
        }
        diffs == 1
    } else {
        let (short, long) = if la < lb { (a, b) } else { (b, a) };
        let mut si = 0;
        let mut li = 0;
        let mut diffs = 0;
        while si < short.len() && li < long.len() {
            if !short[si].eq_ignore_ascii_case(&long[li]) {
                diffs += 1;
                if diffs > 1 {
                    return false;
                }
                li += 1;
            } else {
                si += 1;
                li += 1;
            }
        }
        true
    }
}

fn matches_any_term_for_snippet(word: &[u8], terms: &[&[u8]], phrase_mode: bool) -> bool {
    for term in terms {
        if ascii_eq_ignore_case(word, term) || starts_with_ci(word, term) {
            return true;
        }
        if !phrase_mode && edit_distance_one_ci(word, term) {
            return true;
        }
    }
    false
}

fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    escape_html_into(&mut out, s);
    out
}

fn escape_html_into(out: &mut String, s: &str) {
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\n' => out.push(' '),
            _ => out.push(ch),
        }
    }
}

impl Index {
    /// Full reindex: walk directory, index all .md files. Single commit at end.
    pub fn full_reindex(&self, root: &Path, excluded_folders: &[String], tags: &TagStore) {
        let start = std::time::Instant::now();
        walk_and_index(root, root, self, excluded_folders, tags);
        self.commit();
        fn walk_and_index(
            root: &Path,
            dir: &Path,
            idx: &Index,
            excluded: &[String],
            tags: &TagStore,
        ) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                let name = entry.file_name();
                let name_str = name.to_string_lossy();

                if path.is_dir() {
                    if name_str.starts_with('.') {
                        continue;
                    }
                    if name_str == "z-images" {
                        continue;
                    }
                    if excluded.iter().any(|ex| name_str == *ex) {
                        continue;
                    }
                    walk_and_index(root, &path, idx, excluded, tags);
                    continue;
                }

                if !path.is_file() || !util::is_markdown(&path) {
                    continue;
                }

                if let Ok(content) = fs::read_to_string(&path) {
                    let rel = path.strip_prefix(root).unwrap_or(&path);
                    let rel_str = rel.to_string_lossy();
                    let note_tags = tags.get(&rel_str);
                    idx.add_doc(&rel_str, &content, &path, &note_tags);
                }
            }
        }
        let elapsed = start.elapsed();
        eprintln!("\tindexed in {:.1}ms", elapsed.as_secs_f64() * 1000.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edit_distance_one_substitution() {
        assert!(edit_distance_one_ci(b"cat", b"bat"));
    }

    #[test]
    fn edit_distance_one_insertion() {
        assert!(edit_distance_one_ci(b"lunchctl", b"launchctl"));
    }

    #[test]
    fn edit_distance_one_deletion() {
        assert!(edit_distance_one_ci(b"launchctl", b"lunchctl"));
    }

    #[test]
    fn edit_distance_one_same() {
        assert!(!edit_distance_one_ci(b"foo", b"foo"));
    }

    #[test]
    fn edit_distance_one_too_far() {
        assert!(!edit_distance_one_ci(b"abc", b"xyz"));
    }

    #[test]
    fn edit_distance_one_case_insensitive() {
        assert!(edit_distance_one_ci(b"Cat", b"bat"));
        assert!(edit_distance_one_ci(b"FOO", b"fob"));
    }

    #[test]
    fn starts_with_case_insensitive() {
        assert!(starts_with_ci(b"groats", b"groat"));
        assert!(starts_with_ci(b"Groats", b"groat"));
        assert!(!starts_with_ci(b"groat", b"groat"));
        assert!(!starts_with_ci(b"great", b"groat"));
    }

    fn term_bytes(strs: &[&str]) -> Vec<Vec<u8>> {
        strs.iter().map(|s| s.bytes().collect()).collect()
    }

    fn term_refs(terms: &[Vec<u8>]) -> Vec<&[u8]> {
        terms.iter().map(|t| t.as_slice()).collect()
    }

    fn phrase_bytes(phrases: &[&[&str]]) -> Vec<Vec<Vec<u8>>> {
        phrases
            .iter()
            .map(|phrase| {
                phrase
                    .iter()
                    .map(|word| word.bytes().collect())
                    .collect::<Vec<Vec<u8>>>()
            })
            .collect()
    }

    fn phrase_refs(phrases: &[Vec<Vec<u8>>]) -> Vec<Vec<&[u8]>> {
        phrases
            .iter()
            .map(|phrase| phrase.iter().map(|word| word.as_slice()).collect())
            .collect()
    }

    #[test]
    fn parse_query_extracts_terms_and_phrases() {
        let parsed = parse_query(r#"groat "oat groats" steel-cut"#);
        assert_eq!(parsed.terms, vec!["groat", "oat", "groats", "steel", "cut"]);
        assert_eq!(
            parsed.phrases,
            vec![vec!["oat".to_string(), "groats".to_string()]]
        );
    }

    #[test]
    fn snippet_exact_match() {
        let t = term_bytes(&["fox"]);
        let p = phrase_bytes(&[]);
        let s = make_snippet(
            "the quick brown fox jumps",
            &term_refs(&t),
            &phrase_refs(&p),
            160,
        );
        assert!(s.contains("<b>fox</b>"), "got: {s}");
    }

    #[test]
    fn snippet_fuzzy_match() {
        let t = term_bytes(&["lunchctl"]);
        let p = phrase_bytes(&[]);
        let s = make_snippet(
            "use launchctl to reboot",
            &term_refs(&t),
            &phrase_refs(&p),
            160,
        );
        assert!(s.contains("<b>launchctl</b>"), "got: {s}");
    }

    #[test]
    fn snippet_no_match() {
        let t = term_bytes(&["zzz"]);
        let p = phrase_bytes(&[]);
        let s = make_snippet("hello world", &term_refs(&t), &phrase_refs(&p), 160);
        assert_eq!(s, "hello world");
    }

    #[test]
    fn snippet_escapes_html() {
        let t = term_bytes(&["tag"]);
        let p = phrase_bytes(&[]);
        let s = make_snippet("a <b>tag</b> here", &term_refs(&t), &phrase_refs(&p), 160);
        assert!(s.contains("&lt;b&gt;"), "should escape html: {s}");
        assert!(s.contains("<b>tag</b>"), "should highlight match: {s}");
    }

    #[test]
    fn snippet_case_insensitive() {
        let t = term_bytes(&["hello"]);
        let p = phrase_bytes(&[]);
        let s = make_snippet("Hello World", &term_refs(&t), &phrase_refs(&p), 160);
        assert!(s.contains("<b>Hello</b>"), "got: {s}");
    }

    #[test]
    fn snippet_multibyte_no_panic() {
        let t = term_bytes(&["hello"]);
        let p = phrase_bytes(&[]);
        let content = "📖📖📖📖📖📖📖📖📖📖 hello 📖📖📖📖📖";
        let s = make_snippet(content, &term_refs(&t), &phrase_refs(&p), 160);
        assert!(s.contains("<b>hello</b>"), "got: {s}");
    }

    #[test]
    fn reload_if_dirty_skips_when_clean() {
        let dir = std::env::temp_dir().join(format!("tansu_test_dirty_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let idx = Index::open_or_create(&dir).unwrap();

        // After creation, dirty flag is true (initial state)
        assert!(idx.inner.dirty.load(Ordering::Acquire));

        // First reload clears the flag
        idx.reload_if_dirty();
        assert!(!idx.inner.dirty.load(Ordering::Acquire));

        // Second reload is a no-op (flag stays false)
        idx.reload_if_dirty();
        assert!(!idx.inner.dirty.load(Ordering::Acquire));

        // Commit sets it back to true
        idx.commit();
        assert!(idx.inner.dirty.load(Ordering::Acquire));

        // Reload clears it again
        idx.reload_if_dirty();
        assert!(!idx.inner.dirty.load(Ordering::Acquire));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn snippet_no_match_multibyte() {
        let t = term_bytes(&["zzz"]);
        let p = phrase_bytes(&[]);
        let content = "📖 intro text about things";
        let s = make_snippet(content, &term_refs(&t), &phrase_refs(&p), 10);
        // Should not panic, just truncate safely
        assert!(!s.is_empty());
    }

    #[test]
    fn snippet_prefers_exact_phrase_anchor() {
        let t = term_bytes(&["oat", "groats"]);
        let p = phrase_bytes(&[&["oat", "groats"]]);
        let s = make_snippet(
            "eat beans first. later there are oat groats for breakfast",
            &term_refs(&t),
            &phrase_refs(&p),
            160,
        );
        assert!(s.contains("<b>oat</b> <b>groats</b>"), "got: {s}");
        assert!(
            !s.starts_with("<b>eat</b>"),
            "should anchor on exact phrase: {s}"
        );
    }

    #[test]
    fn word_iter_basic() {
        let words: Vec<_> = WordIter::new("hello world-test foo").collect();
        // Hyphens and underscores split words, matching tantivy's tokenizer
        assert_eq!(words, vec![(0, 5), (6, 11), (12, 16), (17, 20)]);
    }

    #[test]
    fn lazy_commit_and_cache() {
        let dir = std::env::temp_dir().join(format!("tansu_test_lazy_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let idx = Index::open_or_create(&dir).unwrap();

        let tmp = std::env::temp_dir().join("tansu_test_lazy_note.md");
        fs::write(&tmp, "hello world").unwrap();

        // index_note stages the write but doesn't commit
        idx.index_note("test.md", "hello world", &tmp, &[]);
        assert!(idx.inner.uncommitted.load(Ordering::Acquire));

        // get_all_notes triggers ensure_committed + returns the note
        let notes = idx.get_all_notes();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].path, "test.md");
        assert!(!idx.inner.uncommitted.load(Ordering::Acquire));

        // Second call returns cached result
        let notes2 = idx.get_all_notes();
        assert_eq!(notes2.len(), 1);

        // Index another note, cache should be invalidated
        idx.index_note("test2.md", "second note", &tmp, &[]);
        let notes3 = idx.get_all_notes();
        assert_eq!(notes3.len(), 2);

        // Search also triggers commit
        idx.index_note("test3.md", "unique findme word", &tmp, &[]);
        let w = SearchWeights {
            title: 10.0,
            headings: 5.0,
            tags: 2.0,
            content: 1.0,
        };
        let results = idx.search("findme", 10, None, 0, 0, w, false);
        assert!(!results.is_empty());

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn search_hyphenated_and_underscored() {
        let dir = std::env::temp_dir().join(format!("tansu_test_hyphen_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let idx = Index::open_or_create(&dir).unwrap();
        let tmp = std::env::temp_dir().join("tansu_test_hyphen_note.md");
        fs::write(&tmp, "JPEG-XL support and some_function call").unwrap();
        idx.index_note(
            "test.md",
            "JPEG-XL support and some_function call",
            &tmp,
            &[],
        );

        let w = SearchWeights {
            title: 10.0,
            headings: 5.0,
            tags: 2.0,
            content: 1.0,
        };

        // "jpeg-xl" should find the document (hyphen treated as separator)
        let r = idx.search("jpeg-xl", 10, None, 0, 0, w, false);
        assert!(!r.is_empty(), "jpeg-xl should match JPEG-XL");

        // "JPEG-XL" should also work (case insensitive)
        let r = idx.search("JPEG-XL", 10, None, 0, 0, w, false);
        assert!(!r.is_empty(), "JPEG-XL should match");

        // "some_function" should find the document (underscore treated as separator)
        let r = idx.search("some_function", 10, None, 0, 0, w, false);
        assert!(!r.is_empty(), "some_function should match");

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&tmp);
    }

    #[test]
    fn search_uses_metadata_tags_not_markdown_hashtags() {
        let dir = std::env::temp_dir().join(format!("tansu_test_meta_tags_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let idx = Index::open_or_create(&dir).unwrap();

        let body = std::env::temp_dir().join(format!("tansu_body_tag_{}.md", std::process::id()));
        let meta = std::env::temp_dir().join(format!("tansu_meta_tag_{}.md", std::process::id()));
        fs::write(&body, "#alpha appears in body").unwrap();
        fs::write(&meta, "plain content").unwrap();

        idx.index_note("body.md", "#alpha appears in body", &body, &[]);
        idx.index_note("meta.md", "plain content", &meta, &["alpha".to_string()]);

        let w = SearchWeights {
            title: 10.0,
            headings: 5.0,
            tags: 25.0,
            content: 1.0,
        };
        let results = idx.search("alpha", 10, None, 0, 0, w, true);
        assert_eq!(results[0].path, "meta.md");
        assert_eq!(results[0].tags, vec!["alpha"]);
        assert!(results[0].field_scores.tags > 0.0);
        let body_result = results.iter().find(|r| r.path == "body.md").unwrap();
        assert_eq!(body_result.field_scores.tags, 0.0);
        assert!(body_result.field_scores.content > 0.0);

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&body);
        let _ = fs::remove_file(&meta);
    }

    #[test]
    fn full_reindex_reads_tags_from_store() {
        let root =
            std::env::temp_dir().join(format!("tansu_test_full_tags_{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".tansu/index")).unwrap();
        let note = root.join("note.md");
        fs::write(&note, "hello").unwrap();

        let tags = TagStore::open(&root);
        tags.set("note.md", &["alpha".to_string(), "beta".to_string()])
            .unwrap();

        let idx = Index::open_or_create(&root.join(".tansu/index")).unwrap();
        idx.full_reindex(&root, &[], &tags);

        let notes = idx.get_all_notes();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].tags, vec!["alpha", "beta"]);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn search_prefers_prefix_match_over_fuzzy() {
        let dir = std::env::temp_dir().join(format!("tansu_test_prefix_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let idx = Index::open_or_create(&dir).unwrap();

        let groats = std::env::temp_dir().join(format!("tansu_groats_{}.md", std::process::id()));
        let great = std::env::temp_dir().join(format!("tansu_great_{}.md", std::process::id()));
        fs::write(&groats, "A note about groats and porridge").unwrap();
        fs::write(&great, "A note about great porridge").unwrap();

        idx.index_note(
            "groats.md",
            "A note about groats and porridge",
            &groats,
            &[],
        );
        idx.index_note("great.md", "A note about great porridge", &great, &[]);

        let w = SearchWeights {
            title: 10.0,
            headings: 5.0,
            tags: 2.0,
            content: 1.0,
        };
        let results = idx.search("groat", 10, None, 1, 0, w, true);
        assert!(!results.is_empty(), "expected results for groat");
        assert_eq!(results[0].path, "groats.md");
        assert!(
            results[0].excerpt.contains("<b>groats</b>"),
            "expected prefix-highlighted excerpt, got: {}",
            results[0].excerpt
        );
        assert!(
            results[0].field_scores.content >= 0.8,
            "expected prefix score in content, got {}",
            results[0].field_scores.content
        );

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&groats);
        let _ = fs::remove_file(&great);
    }

    #[test]
    fn search_quoted_phrase_requires_literal_order() {
        let dir = std::env::temp_dir().join(format!("tansu_test_phrase_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let idx = Index::open_or_create(&dir).unwrap();

        let exact =
            std::env::temp_dir().join(format!("tansu_phrase_exact_{}.md", std::process::id()));
        let reordered =
            std::env::temp_dir().join(format!("tansu_phrase_reordered_{}.md", std::process::id()));
        fs::write(&exact, "fresh oat groats for breakfast").unwrap();
        fs::write(&reordered, "fresh groats oat for breakfast").unwrap();

        idx.index_note("exact.md", "fresh oat groats for breakfast", &exact, &[]);
        idx.index_note(
            "reordered.md",
            "fresh groats oat for breakfast",
            &reordered,
            &[],
        );

        let w = SearchWeights {
            title: 10.0,
            headings: 5.0,
            tags: 2.0,
            content: 1.0,
        };
        let results = idx.search(r#""oat groats""#, 10, None, 1, 0, w, false);
        assert_eq!(results.len(), 1, "expected only exact phrase match");
        assert_eq!(results[0].path, "exact.md");

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&exact);
        let _ = fs::remove_file(&reordered);
    }

    #[test]
    fn search_applies_recency_boost() {
        let dir = std::env::temp_dir().join(format!("tansu_test_mtime_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let idx = Index::open_or_create(&dir).unwrap();
        let now = now_epoch_secs();
        let older_mtime = now - 30 * 24 * 3600;
        let newer_mtime = now;

        let f = &idx.inner.fields;
        let writer = idx.inner.writer.write().unwrap();

        let mut older = TantivyDocument::new();
        older.add_text(f.path, "older.md");
        older.add_text(f.title, "older");
        older.add_text(f.content, "groats");
        older.add_text(f.headings, "");
        older.add_text(f.tags, "");
        older.add_u64(f.mtime, older_mtime);
        older.add_text(f.links_to, "");
        let _ = writer.add_document(older);

        let mut newer = TantivyDocument::new();
        newer.add_text(f.path, "newer.md");
        newer.add_text(f.title, "newer");
        newer.add_text(f.content, "groats");
        newer.add_text(f.headings, "");
        newer.add_text(f.tags, "");
        newer.add_u64(f.mtime, newer_mtime);
        newer.add_text(f.links_to, "");
        let _ = writer.add_document(newer);
        drop(writer);
        idx.commit();

        let w = SearchWeights {
            title: 10.0,
            headings: 5.0,
            tags: 2.0,
            content: 1.0,
        };
        let results = idx.search("groat", 10, None, 1, 2, w, false);
        assert!(results.len() >= 2, "expected tied results for groat");
        assert_eq!(results[0].path, "newer.md");
        assert_eq!(results[1].path, "older.md");
        assert!(results[0].score > results[1].score);
        assert!(results[0].recency_multiplier > results[1].recency_multiplier);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn get_all_notes_no_duplicates_after_update() {
        // Regression: get_all_notes() used to iterate 0..num_docs() (the live count)
        // instead of 0..max_doc(). Tantivy doc IDs are not compacted after soft
        // deletes, so the two ranges differ once a doc is deleted.
        //
        // Concretely: segment A has alpha.md at doc_id=0, beta.md at doc_id=1.
        // After updating alpha.md, doc_id=0 is soft-deleted and the new alpha.md
        // lands in segment B. Segment A now has num_docs()=1, max_doc()=2.
        // The old 0..num_docs() loop visited deleted alpha at doc_id=0 (no alive
        // check) and skipped live beta at doc_id=1, returning stale+duplicate entries.
        let dir = std::env::temp_dir().join(format!("tansu_test_dedup_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let idx = Index::open_or_create(&dir).unwrap();

        let alpha = std::env::temp_dir().join(format!("tansu_alpha_{}.md", std::process::id()));
        let beta = std::env::temp_dir().join(format!("tansu_beta_{}.md", std::process::id()));

        // Index alpha then beta in the same batch → segment A: alpha=doc_id=0, beta=doc_id=1.
        fs::write(&alpha, "alpha v1").unwrap();
        idx.index_note("alpha.md", "alpha v1", &alpha, &[]);
        fs::write(&beta, "beta content").unwrap();
        idx.index_note("beta.md", "beta content", &beta, &[]);
        let _ = idx.get_all_notes(); // ensure_committed → flushes segment A

        // Update alpha: delete_term marks doc_id=0 in segment A as deleted.
        // new alpha goes into segment B at doc_id=0.
        // Segment A: max_doc=2, num_docs=1; deleted doc is at the LOWER id (0),
        // live beta is at the HIGHER id (1) — this is what triggers the old bug.
        fs::write(&alpha, "alpha v2").unwrap();
        idx.index_note("alpha.md", "alpha v2", &alpha, &[]);

        let notes = idx.get_all_notes();
        let paths: Vec<&str> = notes.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(notes.len(), 2, "expected 2 notes, got {:?}", paths);
        assert!(
            paths.contains(&"alpha.md"),
            "missing alpha.md in {:?}",
            paths
        );
        assert!(paths.contains(&"beta.md"), "missing beta.md in {:?}", paths);

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&alpha);
        let _ = fs::remove_file(&beta);
    }

    /// Regression test: get_all_notes() must use max_doc() (not num_docs()) and check
    /// alive_bitset() to skip soft-deleted docs. Tantivy doc IDs are not compacted after
    /// soft deletes, so iterating 0..num_docs() visits the wrong doc IDs.
    ///
    /// Uses a single-threaded writer so alpha and beta land in one segment on commit 1.
    /// After updating alpha in commit 2, segment A has alpha(deleted,doc_id=0) and
    /// beta(live,doc_id=1), num_docs=1, max_doc=2.
    ///
    /// Old bug: loop 0..num_docs (0..1) visits deleted alpha, misses live beta.
    /// Returns [alpha_v1, alpha_v2] — beta missing.
    ///
    /// Fixed: loop 0..max_doc (0..2), skip dead doc_id=0, return beta from seg A and
    /// alpha_v2 from seg B.
    #[test]
    fn get_all_notes_no_duplicates_after_update_raw() {
        let dir = std::env::temp_dir().join(format!("tansu_test_raw_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // Build the bug scenario using a single-threaded raw Tantivy writer so both
        // initial docs are guaranteed to land in one segment. Schema must match
        // Index::open_or_create field order exactly (path=0, title=1, ...) so that
        // get_all_notes() reads the correct field IDs when we re-open below.
        {
            let mut sb = Schema::builder();
            let path_field = sb.add_text_field("path", STRING | STORED);
            let title_field = sb.add_text_field("title", TEXT | STORED);
            // Remaining fields maintain production field-ID order; get_all_notes()
            // only reads path and title, so their stored values don't matter here.
            let _ = sb.add_text_field("content", TEXT | STORED);
            let _ = sb.add_text_field("headings", TEXT | STORED);
            let _ = sb.add_text_field("tags", TEXT | STORED);
            let _ = sb.add_u64_field("mtime", STORED | FAST);
            let _ = sb.add_text_field("links_to", TEXT | STORED);

            let raw_index = TantivyIndex::create_in_dir(&dir, sb.build()).unwrap();
            let mut writer = raw_index.writer_with_num_threads(1, 15_000_000).unwrap();

            let make_doc = |path: &str, title: &str| {
                let mut doc = TantivyDocument::new();
                doc.add_text(path_field, path);
                doc.add_text(title_field, title);
                doc
            };

            // Commit 1: alpha + beta into one segment (single-thread writer).
            writer.delete_term(tantivy::Term::from_field_text(path_field, "alpha.md"));
            let _ = writer.add_document(make_doc("alpha.md", "alpha v1"));
            writer.delete_term(tantivy::Term::from_field_text(path_field, "beta.md"));
            let _ = writer.add_document(make_doc("beta.md", "beta"));
            writer.commit().unwrap();

            // Commit 2: update alpha → seg A: alpha(deleted,doc_id=0), beta(live,doc_id=1),
            // num_docs=1, max_doc=2. New alpha lands in seg B.
            writer.delete_term(tantivy::Term::from_field_text(path_field, "alpha.md"));
            let _ = writer.add_document(make_doc("alpha.md", "alpha v2"));
            writer.commit().unwrap();
            // writer + raw_index dropped here, releasing the lock file.
        }

        // Open via the production path and call the production get_all_notes().
        // open_or_create detects meta.json and calls open_in_dir, reusing the on-disk schema.
        let idx = Index::open_or_create(&dir).unwrap();
        let notes = idx.get_all_notes();
        let paths: Vec<&str> = notes.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(notes.len(), 2, "expected 2 notes, got {:?}", paths);
        assert!(
            paths.contains(&"alpha.md"),
            "missing alpha.md in {:?}",
            paths
        );
        assert!(paths.contains(&"beta.md"), "missing beta.md in {:?}", paths);

        let _ = fs::remove_dir_all(&dir);
    }
}
