use std::{
    fs,
    path::Path,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
};

use tantivy::{
    Index as TantivyIndex, IndexReader, IndexWriter, TantivyDocument,
    collector::TopDocs,
    query::{BooleanQuery, FuzzyTermQuery, Occur, TermQuery},
    schema::*,
};

use crate::util::StrExt;
use crate::{http, scanner, strip, util};

#[derive(Clone)]
pub struct NoteEntry {
    pub path: String,
    pub title: String,
}

pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub excerpt: String,
    pub score: f32,
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
    fn add_doc(&self, rel_path: &str, content: &str, full_path: &Path) {
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
        doc.add_text(f.headings, &scan.headings.join(" "));
        doc.add_text(f.tags, &scan.tags.join(" "));
        doc.add_u64(f.mtime, mtime);
        doc.add_text(f.links_to, &scan.links.join(" "));

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
    pub fn index_note(&self, rel_path: &str, content: &str, full_path: &Path) {
        self.add_doc(rel_path, content, full_path);
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

    /// Two-phase search: exact first, fuzzy fallback if <5 results.
    /// `weights` order: [title, headings, tags, content].
    pub fn search(
        &self,
        query: &str,
        limit: usize,
        filter_path: Option<&str>,
        fuzzy_distance: u8,
        weights: SearchWeights,
        score_breakdown: bool,
    ) -> Vec<SearchResult> {
        self.ensure_committed();
        self.reload_if_dirty();
        let searcher = self.inner.reader.searcher();

        // Split on non-alphanumeric chars to match tantivy's default tokenizer,
        // so "jpeg-xl" and "some_function" match indexed tokens
        let terms: Vec<&str> = query
            .split(|c: char| !c.is_alphanumeric())
            .filter(|s| !s.is_empty())
            .collect();
        if terms.is_empty() {
            return Vec::new();
        }

        // Phase 1: exact
        let phase1_query = self.build_query(&terms, false, filter_path, fuzzy_distance, weights);
        let results = self.execute_search(
            &searcher,
            &phase1_query,
            limit,
            &terms,
            weights,
            score_breakdown,
        );

        if results.len() >= 5 {
            return results;
        }

        // Phase 2: add fuzzy
        let phase2_query = self.build_query(&terms, true, filter_path, fuzzy_distance, weights);
        self.execute_search(
            &searcher,
            &phase2_query,
            limit,
            &terms,
            weights,
            score_breakdown,
        )
    }

    fn build_query(
        &self,
        terms: &[&str],
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

        for &word in terms {
            let word_lower = word.to_lowercase();
            let mut field_queries: Vec<(Occur, Box<dyn tantivy::query::Query>)> = Vec::new();

            for &(field, boost) in &search_fields {
                let term = tantivy::Term::from_field_text(field, &word_lower);

                let exact = TermQuery::new(term.clone(), IndexRecordOption::WithFreqs);
                field_queries.push((
                    Occur::Should,
                    Box::new(tantivy::query::BoostQuery::new(Box::new(exact), boost)),
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
        terms: &[&str],
        weights: SearchWeights,
        score_breakdown: bool,
    ) -> Vec<SearchResult> {
        let f = &self.inner.fields;
        let Ok(top_docs) = searcher.search(query, &TopDocs::with_limit(limit)) else {
            return Vec::new();
        };

        // Pre-lowercase terms as bytes once for all results
        let lower_terms: Vec<Vec<u8>> = terms
            .iter()
            .map(|t| t.bytes().map(|b| b.to_ascii_lowercase()).collect())
            .collect();
        let term_refs: Vec<&[u8]> = lower_terms.iter().map(|t| t.as_slice()).collect();

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
            let content = doc
                .get_first(f.content)
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let excerpt = make_snippet(content, &term_refs, 160);

            let field_scores = if score_breakdown {
                compute_field_scores(&doc, f, &term_refs, weights)
            } else {
                FieldScores::default()
            };

            results.push(SearchResult {
                path,
                title,
                excerpt,
                score,
                field_scores,
            });
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
                if !path.is_empty() {
                    notes.push(NoteEntry { path, title });
                }
            }
        }

        *self.inner.notes_cache.lock().unwrap() = Some(notes.clone());
        notes
    }
}

/// Compute per-field scores by counting term matches (exact + fuzzy) against stored values.
fn compute_field_scores(
    doc: &TantivyDocument,
    f: &Fields,
    terms: &[&[u8]],
    weights: SearchWeights,
) -> FieldScores {
    let get =
        |field: Field| -> &str { doc.get_first(field).and_then(|v| v.as_str()).unwrap_or("") };

    let fields = [
        (get(f.title), weights.title),
        (get(f.headings), weights.headings),
        (get(f.tags), weights.tags),
        (get(f.content), weights.content),
    ];

    let mut scores = [0.0f32; 4];

    for (i, &(text, boost)) in fields.iter().enumerate() {
        for (start, end) in WordIter::new(text) {
            let word = &text.as_bytes()[start..end];
            for term in terms {
                if ascii_eq_ignore_case(word, term) {
                    scores[i] += boost;
                } else if edit_distance_one_ci(word, term) {
                    scores[i] += boost * 0.6;
                }
            }
        }
    }

    FieldScores {
        title: scores[0],
        headings: scores[1],
        tags: scores[2],
        content: scores[3],
    }
}

/// Build a snippet from content with highlighted query terms (supports fuzzy matching).
fn make_snippet(content: &str, terms: &[&[u8]], max_len: usize) -> String {
    if content.is_empty() || terms.is_empty() {
        return String::new();
    }

    // Find the first matching word to anchor the window
    let first_match = WordIter::new(content)
        .find(|&(start, end)| matches_any_term(&content.as_bytes()[start..end], terms));

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
        if matches_any_term(&content.as_bytes()[abs_start..abs_end], terms) {
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
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(x, y)| x.to_ascii_lowercase() == y.to_ascii_lowercase())
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
            if a[i].to_ascii_lowercase() != b[i].to_ascii_lowercase() {
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
            if short[si].to_ascii_lowercase() != long[li].to_ascii_lowercase() {
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

/// Check if a word matches any term (exact or edit distance 1), case-insensitive.
fn matches_any_term(word: &[u8], terms: &[&[u8]]) -> bool {
    for term in terms {
        if ascii_eq_ignore_case(word, term) || edit_distance_one_ci(word, term) {
            return true;
        }
    }
    false
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
    pub fn full_reindex(&self, root: &Path, excluded_folders: &[String]) {
        let start = std::time::Instant::now();
        walk_and_index(root, root, self, excluded_folders);
        self.commit();
        fn walk_and_index(root: &Path, dir: &Path, idx: &Index, excluded: &[String]) {
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
                    walk_and_index(root, &path, idx, excluded);
                    continue;
                }

                if !path.is_file() || !util::is_markdown(&path) {
                    continue;
                }

                if let Ok(content) = fs::read_to_string(&path) {
                    let rel = path.strip_prefix(root).unwrap_or(&path);
                    let rel_str = rel.to_string_lossy();
                    idx.add_doc(&rel_str, &content, &path);
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

    fn term_bytes(strs: &[&str]) -> Vec<Vec<u8>> {
        strs.iter().map(|s| s.bytes().collect()).collect()
    }

    fn term_refs(terms: &[Vec<u8>]) -> Vec<&[u8]> {
        terms.iter().map(|t| t.as_slice()).collect()
    }

    #[test]
    fn snippet_exact_match() {
        let t = term_bytes(&["fox"]);
        let s = make_snippet("the quick brown fox jumps", &term_refs(&t), 160);
        assert!(s.contains("<b>fox</b>"), "got: {s}");
    }

    #[test]
    fn snippet_fuzzy_match() {
        let t = term_bytes(&["lunchctl"]);
        let s = make_snippet("use launchctl to reboot", &term_refs(&t), 160);
        assert!(s.contains("<b>launchctl</b>"), "got: {s}");
    }

    #[test]
    fn snippet_no_match() {
        let t = term_bytes(&["zzz"]);
        let s = make_snippet("hello world", &term_refs(&t), 160);
        assert_eq!(s, "hello world");
    }

    #[test]
    fn snippet_escapes_html() {
        let t = term_bytes(&["tag"]);
        let s = make_snippet("a <b>tag</b> here", &term_refs(&t), 160);
        assert!(s.contains("&lt;b&gt;"), "should escape html: {s}");
        assert!(s.contains("<b>tag</b>"), "should highlight match: {s}");
    }

    #[test]
    fn snippet_case_insensitive() {
        let t = term_bytes(&["hello"]);
        let s = make_snippet("Hello World", &term_refs(&t), 160);
        assert!(s.contains("<b>Hello</b>"), "got: {s}");
    }

    #[test]
    fn snippet_multibyte_no_panic() {
        let t = term_bytes(&["hello"]);
        let content = "📖📖📖📖📖📖📖📖📖📖 hello 📖📖📖📖📖";
        let s = make_snippet(content, &term_refs(&t), 160);
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
        let content = "📖 intro text about things";
        let s = make_snippet(content, &term_refs(&t), 10);
        // Should not panic, just truncate safely
        assert!(!s.is_empty());
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
        idx.index_note("test.md", "hello world", &tmp);
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
        idx.index_note("test2.md", "second note", &tmp);
        let notes3 = idx.get_all_notes();
        assert_eq!(notes3.len(), 2);

        // Search also triggers commit
        idx.index_note("test3.md", "unique findme word", &tmp);
        let w = SearchWeights {
            title: 10.0,
            headings: 5.0,
            tags: 2.0,
            content: 1.0,
        };
        let results = idx.search("findme", 10, None, 0, w, false);
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
        idx.index_note("test.md", "JPEG-XL support and some_function call", &tmp);

        let w = SearchWeights {
            title: 10.0,
            headings: 5.0,
            tags: 2.0,
            content: 1.0,
        };

        // "jpeg-xl" should find the document (hyphen treated as separator)
        let r = idx.search("jpeg-xl", 10, None, 0, w, false);
        assert!(!r.is_empty(), "jpeg-xl should match JPEG-XL");

        // "JPEG-XL" should also work (case insensitive)
        let r = idx.search("JPEG-XL", 10, None, 0, w, false);
        assert!(!r.is_empty(), "JPEG-XL should match");

        // "some_function" should find the document (underscore treated as separator)
        let r = idx.search("some_function", 10, None, 0, w, false);
        assert!(!r.is_empty(), "some_function should match");

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_file(&tmp);
    }
}
