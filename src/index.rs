use std::{
    fs,
    path::Path,
    sync::{Arc, RwLock, atomic::{AtomicBool, Ordering}},
};

use tantivy::{
    IndexWriter, IndexReader, Index as TantivyIndex, TantivyDocument,
    collector::TopDocs,
    query::{BooleanQuery, FuzzyTermQuery, Occur, TermQuery},
    schema::*,
};

use crate::http;
use crate::scanner;
use crate::strip;
use crate::util::StrExt;

pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub excerpt: String,
    pub score: f32,
    pub field_scores: FieldScores,
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
    }

    /// Reload the reader only if the index has been committed to since last reload.
    fn reload_if_dirty(&self) {
        if self.inner.dirty.swap(false, Ordering::AcqRel) {
            let _ = self.inner.reader.reload();
        }
    }

    /// Index a single note and commit immediately.
    pub fn index_note(&self, rel_path: &str, content: &str, full_path: &Path) {
        self.add_doc(rel_path, content, full_path);
        self.commit();
    }

    /// Index a single note without committing. Call `commit()` separately.
    pub fn index_note_deferred(&self, rel_path: &str, content: &str, full_path: &Path) {
        self.add_doc(rel_path, content, full_path);
    }

    pub fn remove_note(&self, rel_path: &str) {
        let mut writer = self.inner.writer.write().unwrap();
        let path_term = tantivy::Term::from_field_text(self.inner.fields.path, rel_path);
        writer.delete_term(path_term);
        let _ = writer.commit();
        self.inner.dirty.store(true, Ordering::Release);
    }

    pub fn remove_note_deferred(&self, rel_path: &str) {
        let writer = self.inner.writer.write().unwrap();
        let path_term = tantivy::Term::from_field_text(self.inner.fields.path, rel_path);
        writer.delete_term(path_term);
    }

    /// Two-phase search: exact first, fuzzy fallback if <5 results.
    /// `weights` order: [title, headings, tags, content].
    pub fn search(
        &self, query: &str, limit: usize, filter_path: Option<&str>,
        fuzzy_distance: u8, weights: [f32; 4],
    ) -> Vec<SearchResult> {
        self.reload_if_dirty();
        let searcher = self.inner.reader.searcher();

        let terms: Vec<&str> = query.split_whitespace().collect();
        if terms.is_empty() {
            return Vec::new();
        }

        // Phase 1: exact
        let phase1_query = self.build_query(&terms, false, filter_path, fuzzy_distance, weights);
        let results = self.execute_search(&searcher, &phase1_query, limit, &terms, weights);

        if results.len() >= 5 {
            return results;
        }

        // Phase 2: add fuzzy
        let phase2_query = self.build_query(&terms, true, filter_path, fuzzy_distance, weights);
        self.execute_search(&searcher, &phase2_query, limit, &terms, weights)
    }

    fn build_query(
        &self, terms: &[&str], fuzzy: bool, filter_path: Option<&str>,
        fuzzy_distance: u8, weights: [f32; 4],
    ) -> BooleanQuery {
        let f = &self.inner.fields;
        let search_fields = [
            (f.title, weights[0]),
            (f.headings, weights[1]),
            (f.tags, weights[2]),
            (f.content, weights[3]),
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
        weights: [f32; 4],
    ) -> Vec<SearchResult> {
        let f = &self.inner.fields;
        let Ok(top_docs) = searcher.search(query, &TopDocs::with_limit(limit)) else {
            return Vec::new();
        };

        let mut results = Vec::new();
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
            let excerpt = make_snippet(content, terms, 160);

            let field_scores = compute_field_scores(&doc, f, terms, weights);

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

    pub fn get_all_notes(&self) -> Vec<(String, String)> {
        self.reload_if_dirty();
        let searcher = self.inner.reader.searcher();
        let f = &self.inner.fields;

        let mut notes = Vec::new();
        for segment_reader in searcher.segment_readers() {
            let Ok(store_reader) = segment_reader.get_store_reader(1) else {
                continue;
            };
            for doc_id in 0..segment_reader.num_docs() {
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
                    notes.push((path, title));
                }
            }
        }
        notes
    }

}

/// Compute per-field scores by counting term matches (exact + fuzzy) against stored values.
fn compute_field_scores(doc: &TantivyDocument, f: &Fields, terms: &[&str], weights: [f32; 4]) -> FieldScores {
    let get = |field: Field| -> &str {
        doc.get_first(field).and_then(|v| v.as_str()).unwrap_or("")
    };

    let fields = [
        (get(f.title), weights[0]),
        (get(f.headings), weights[1]),
        (get(f.tags), weights[2]),
        (get(f.content), weights[3]),
    ];

    let lower_terms: Vec<String> = terms.iter().map(|t| t.to_lowercase()).collect();
    let mut scores = [0.0f32; 4];

    for (i, &(text, boost)) in fields.iter().enumerate() {
        let words = word_positions(text);
        for &(start, end) in &words {
            let word = text[start..end].to_lowercase();
            for term in &lower_terms {
                if word == *term {
                    scores[i] += boost;
                } else if edit_distance_one(&word, term) {
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
fn make_snippet(content: &str, terms: &[&str], max_len: usize) -> String {
    if content.is_empty() || terms.is_empty() {
        return String::new();
    }

    // Find all word boundaries and their positions
    let words: Vec<(usize, usize)> = word_positions(content);
    if words.is_empty() {
        return String::new();
    }

    // Find which words match any query term (exact or edit distance 1)
    let lower_terms: Vec<String> = terms.iter().map(|t| t.to_lowercase()).collect();
    let mut match_positions: Vec<(usize, usize)> = Vec::new(); // (start, end) of matching words
    for &(start, end) in &words {
        let word = content[start..end].to_lowercase();
        for term in &lower_terms {
            if word == *term || edit_distance_one(&word, term) {
                match_positions.push((start, end));
                break;
            }
        }
    }

    if match_positions.is_empty() {
        // No matches — return beginning of content
        return escape_html(content.truncate_bytes(max_len));
    }

    // Pick window around the first match
    let first_match = match_positions[0].0;
    let window_start = content.floor_char_boundary(first_match.saturating_sub(40));
    // Align to word boundary
    let window_start = content[..window_start]
        .rfind(|c: char| c.is_whitespace())
        .map(|p| p + 1)
        .unwrap_or(0);
    let window_end = content.floor_char_boundary((window_start + max_len).min(content.len()));
    let window_end = content[window_end..]
        .find(|c: char| c.is_whitespace())
        .map(|p| window_end + p)
        .unwrap_or(content.len());

    // Build output with <b> tags around matches
    let mut out = String::new();
    let mut pos = window_start;
    for &(ms, me) in &match_positions {
        if ms < window_start || me > window_end {
            continue;
        }
        if ms > pos {
            out.push_str(&escape_html(&content[pos..ms]));
        }
        out.push_str("<b>");
        out.push_str(&escape_html(&content[ms..me]));
        out.push_str("</b>");
        pos = me;
    }
    if pos < window_end {
        out.push_str(&escape_html(&content[pos..window_end]));
    }

    out
}

fn word_positions(s: &str) -> Vec<(usize, usize)> {
    let mut words = Vec::new();
    let mut i = 0;
    let bytes = s.as_bytes();
    while i < bytes.len() {
        if bytes[i].is_ascii_alphanumeric() {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'-' || bytes[i] == b'_') {
                i += 1;
            }
            words.push((start, i));
        } else {
            i += 1;
        }
    }
    words
}

/// Check if two strings have edit distance exactly 1.
fn edit_distance_one(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    let (la, lb) = (a.len(), b.len());
    if la.abs_diff(lb) > 1 {
        return false;
    }
    if la == lb {
        // Substitution: exactly one position differs
        let mut diffs = 0;
        for i in 0..la {
            if a[i] != b[i] {
                diffs += 1;
                if diffs > 1 { return false; }
            }
        }
        diffs == 1
    } else {
        // Insertion/deletion
        let (short, long) = if la < lb { (a, b) } else { (b, a) };
        let mut si = 0;
        let mut li = 0;
        let mut diffs = 0;
        while si < short.len() && li < long.len() {
            if short[si] != long[li] {
                diffs += 1;
                if diffs > 1 { return false; }
                li += 1;
            } else {
                si += 1;
                li += 1;
            }
        }
        true
    }
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
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
    out
}

impl Index {
    /// Full reindex: walk directory, index all .md files. Single commit at end.
    pub fn full_reindex(&self, root: &Path, excluded_folders: &[String]) {
        let start = std::time::Instant::now();
        walk_and_index(root, root, self, excluded_folders);
        self.commit();
        fn walk_and_index(root: &Path, dir: &Path, idx: &Index, excluded: &[String]) {
            let Ok(entries) = fs::read_dir(dir) else { return };
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

                if !path.is_file() {
                    continue;
                }
                let is_md = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"));
                if !is_md {
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
        assert!(edit_distance_one("cat", "bat"));
    }

    #[test]
    fn edit_distance_one_insertion() {
        assert!(edit_distance_one("lunchctl", "launchctl"));
    }

    #[test]
    fn edit_distance_one_deletion() {
        assert!(edit_distance_one("launchctl", "lunchctl"));
    }

    #[test]
    fn edit_distance_one_same() {
        assert!(!edit_distance_one("foo", "foo"));
    }

    #[test]
    fn edit_distance_one_too_far() {
        assert!(!edit_distance_one("abc", "xyz"));
    }

    #[test]
    fn snippet_exact_match() {
        let s = make_snippet("the quick brown fox jumps", &["fox"], 160);
        assert!(s.contains("<b>fox</b>"), "got: {s}");
    }

    #[test]
    fn snippet_fuzzy_match() {
        let s = make_snippet("use launchctl to reboot", &["lunchctl"], 160);
        assert!(s.contains("<b>launchctl</b>"), "got: {s}");
    }

    #[test]
    fn snippet_no_match() {
        let s = make_snippet("hello world", &["zzz"], 160);
        assert_eq!(s, "hello world");
    }

    #[test]
    fn snippet_escapes_html() {
        let s = make_snippet("a <b>tag</b> here", &["tag"], 160);
        assert!(s.contains("&lt;b&gt;"), "should escape html: {s}");
        assert!(s.contains("<b>tag</b>"), "should highlight match: {s}");
    }

    #[test]
    fn snippet_case_insensitive() {
        let s = make_snippet("Hello World", &["hello"], 160);
        assert!(s.contains("<b>Hello</b>"), "got: {s}");
    }

    #[test]
    fn snippet_multibyte_no_panic() {
        // Emoji are 4 bytes each; window arithmetic must not split them
        let content = "📖📖📖📖📖📖📖📖📖📖 hello 📖📖📖📖📖";
        let s = make_snippet(content, &["hello"], 160);
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
        let content = "📖 intro text about things";
        let s = make_snippet(content, &["zzz"], 10);
        // Should not panic, just truncate safely
        assert!(!s.is_empty());
    }

}
