use std::{
    fs,
    path::Path,
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
};

use tantivy::{
    Index as TantivyIndex, IndexReader, IndexWriter, Order, TantivyDocument,
    collector::TopDocs,
    query::{AllQuery, BooleanQuery, FuzzyTermQuery, Occur, TermQuery},
    schema::*,
};

use crate::{http, util};

pub struct NameEntry {
    pub path: String,
    pub title: String,
    pub mtime: u64,
}

struct Fields {
    path: Field,
    stem: Field,
    mtime: Field,
}

struct Inner {
    writer: RwLock<IndexWriter>,
    reader: IndexReader,
    fields: Fields,
    dirty: AtomicBool,
    uncommitted: AtomicBool,
}

#[derive(Clone)]
pub struct FileNameIndex {
    inner: Arc<Inner>,
}

impl FileNameIndex {
    pub fn open_or_create(dir: &Path) -> tantivy::Result<Self> {
        let mut schema_builder = Schema::builder();
        let path_field = schema_builder.add_text_field("path", STRING | STORED);
        let stem_field = schema_builder.add_text_field("stem", TEXT | STORED);
        let mtime_field = schema_builder.add_u64_field("mtime", STORED | FAST);
        let schema = schema_builder.build();

        let index = if dir.join("meta.json").exists() {
            TantivyIndex::open_in_dir(dir)?
        } else {
            TantivyIndex::create_in_dir(dir, schema)?
        };

        let writer = index.writer(15_000_000)?;
        let reader = index.reader()?;

        Ok(FileNameIndex {
            inner: Arc::new(Inner {
                writer: RwLock::new(writer),
                reader,
                fields: Fields {
                    path: path_field,
                    stem: stem_field,
                    mtime: mtime_field,
                },
                dirty: AtomicBool::new(true),
                uncommitted: AtomicBool::new(false),
            }),
        })
    }

    fn add_doc(&self, rel_path: &str, mtime: u64) {
        let f = &self.inner.fields;
        let stem = Path::new(rel_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(rel_path)
            .to_string();

        let writer = self.inner.writer.write().unwrap();
        let path_term = tantivy::Term::from_field_text(f.path, rel_path);
        writer.delete_term(path_term);

        let mut doc = TantivyDocument::new();
        doc.add_text(f.path, rel_path);
        doc.add_text(f.stem, &stem);
        doc.add_u64(f.mtime, mtime);
        let _ = writer.add_document(doc);
    }

    pub fn commit(&self) {
        let mut writer = self.inner.writer.write().unwrap();
        let _ = writer.commit();
        self.inner.dirty.store(true, Ordering::Release);
        self.inner.uncommitted.store(false, Ordering::Release);
    }

    fn ensure_committed(&self) {
        if self.inner.uncommitted.swap(false, Ordering::AcqRel) {
            let mut writer = self.inner.writer.write().unwrap();
            let _ = writer.commit();
            self.inner.dirty.store(true, Ordering::Release);
        }
    }

    fn reload_if_dirty(&self) {
        if self.inner.dirty.swap(false, Ordering::AcqRel) {
            let _ = self.inner.reader.reload();
        }
    }

    pub fn index_file(&self, rel_path: &str, mtime: u64) {
        self.add_doc(rel_path, mtime);
        self.inner.uncommitted.store(true, Ordering::Release);
    }

    pub fn remove_file(&self, rel_path: &str) {
        let writer = self.inner.writer.write().unwrap();
        let path_term = tantivy::Term::from_field_text(self.inner.fields.path, rel_path);
        writer.delete_term(path_term);
        drop(writer);
        self.inner.uncommitted.store(true, Ordering::Release);
    }

    /// Fuzzy search over file name stems. Each query token must match (AND).
    pub fn search_names(&self, query: &str, limit: usize) -> Vec<NameEntry> {
        self.ensure_committed();
        self.reload_if_dirty();
        let searcher = self.inner.reader.searcher();
        let f = &self.inner.fields;

        let terms: Vec<&str> = query
            .split(|c: char| !c.is_alphanumeric())
            .filter(|s| !s.is_empty())
            .collect();
        if terms.is_empty() {
            return Vec::new();
        }

        let mut term_queries: Vec<(Occur, Box<dyn tantivy::query::Query>)> = Vec::new();
        for word in &terms {
            let word_lower = word.to_lowercase();
            let term = tantivy::Term::from_field_text(f.stem, &word_lower);
            let exact = TermQuery::new(term.clone(), IndexRecordOption::WithFreqs);
            let fuzzy = FuzzyTermQuery::new(term, 1, true);
            let word_q = BooleanQuery::new(vec![
                (Occur::Should, Box::new(exact) as Box<dyn tantivy::query::Query>),
                (Occur::Should, Box::new(fuzzy) as Box<dyn tantivy::query::Query>),
            ]);
            term_queries.push((Occur::Must, Box::new(word_q)));
        }

        let query = BooleanQuery::new(term_queries);
        let Ok(top_docs) = searcher.search(&query, &TopDocs::with_limit(limit)) else {
            return Vec::new();
        };

        top_docs
            .into_iter()
            .filter_map(|(_, addr)| {
                let doc = searcher.doc::<TantivyDocument>(addr).ok()?;
                let path = doc.get_first(f.path)?.as_str()?.to_string();
                let title = doc.get_first(f.stem)?.as_str()?.to_string();
                let mtime = doc.get_first(f.mtime)?.as_u64()?;
                Some(NameEntry { path, title, mtime })
            })
            .collect()
    }

    /// Look up a single file by exact path, returning its title (stem) if found.
    pub fn lookup_path(&self, rel_path: &str) -> Option<String> {
        self.ensure_committed();
        self.reload_if_dirty();
        let searcher = self.inner.reader.searcher();
        let f = &self.inner.fields;
        let term = tantivy::Term::from_field_text(f.path, rel_path);
        let query = TermQuery::new(term, IndexRecordOption::Basic);
        let top_docs = searcher.search(&query, &TopDocs::with_limit(1)).ok()?;
        let (_, addr) = top_docs.into_iter().next()?;
        let doc = searcher.doc::<TantivyDocument>(addr).ok()?;
        Some(doc.get_first(f.stem)?.as_str()?.to_string())
    }

    /// Return the N most recently modified files, sorted by mtime descending.
    pub fn recent(&self, n: usize) -> Vec<NameEntry> {
        self.ensure_committed();
        self.reload_if_dirty();
        let searcher = self.inner.reader.searcher();
        let f = &self.inner.fields;

        let collector = TopDocs::with_limit(n).order_by_fast_field::<u64>("mtime", Order::Desc);
        let Ok(top_docs) = searcher.search(&AllQuery, &collector) else {
            return Vec::new();
        };

        top_docs
            .into_iter()
            .filter_map(|(mtime, addr)| {
                let doc = searcher.doc::<TantivyDocument>(addr).ok()?;
                let path = doc.get_first(f.path)?.as_str()?.to_string();
                let title = doc.get_first(f.stem)?.as_str()?.to_string();
                Some(NameEntry { path, title, mtime })
            })
            .collect()
    }

    pub fn full_reindex(&self, root: &Path, excluded_folders: &[String]) {
        walk_and_index(root, root, self, excluded_folders);
        self.commit();

        fn walk_and_index(root: &Path, dir: &Path, idx: &FileNameIndex, excluded: &[String]) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                let name = entry.file_name();
                let name_str = name.to_string_lossy();

                if path.is_dir() {
                    if name_str.starts_with('.') || name_str == "z-images" {
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

                let rel = path.strip_prefix(root).unwrap_or(&path);
                let rel_str = rel.to_string_lossy();
                let mtime = http::mtime_secs(&path);
                idx.add_doc(&rel_str, mtime);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_idx(suffix: &str) -> (FileNameIndex, std::path::PathBuf) {
        let dir = std::env::temp_dir()
            .join(format!("tansu_names_{}_{}", suffix, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let idx = FileNameIndex::open_or_create(&dir).unwrap();
        (idx, dir)
    }

    #[test]
    fn search_exact_match() {
        let (idx, dir) = make_idx("exact");
        idx.index_file("projects/my-rust-notes.md", 1000);
        idx.index_file("random.md", 2000);
        let results = idx.search_names("rust", 10);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "projects/my-rust-notes.md");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_fuzzy_match() {
        let (idx, dir) = make_idx("fuzzy");
        idx.index_file("launchctl-notes.md", 1000);
        // "lunchctl" is edit-distance 1 from "launchctl"
        let results = idx.search_names("lunchctl", 10);
        assert!(!results.is_empty(), "fuzzy should match launchctl");
        assert_eq!(results[0].path, "launchctl-notes.md");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_case_insensitive() {
        let (idx, dir) = make_idx("case");
        idx.index_file("Rust-Notes.md", 1000);
        let results = idx.search_names("rust", 10);
        assert!(!results.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_multi_token_and() {
        let (idx, dir) = make_idx("multi");
        idx.index_file("rust-tokio-notes.md", 1000);
        idx.index_file("rust-stdlib-notes.md", 2000);
        // Both tokens required — only rust-tokio-notes has "tokio"
        let results = idx.search_names("rust tokio", 10);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "rust-tokio-notes.md");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_empty_query_returns_nothing() {
        let (idx, dir) = make_idx("empty");
        idx.index_file("note.md", 1000);
        assert!(idx.search_names("", 10).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn title_is_stem_not_extension() {
        let (idx, dir) = make_idx("title");
        idx.index_file("my-great-note.md", 1000);
        let results = idx.search_names("great", 10);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "my-great-note");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recent_sorted_descending() {
        let (idx, dir) = make_idx("recent_sort");
        idx.index_file("old.md", 1000);
        idx.index_file("new.md", 9000);
        idx.index_file("middle.md", 5000);
        let results = idx.recent(10);
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].path, "new.md");
        assert_eq!(results[1].path, "middle.md");
        assert_eq!(results[2].path, "old.md");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recent_respects_limit() {
        let (idx, dir) = make_idx("recent_limit");
        for i in 0..10u64 {
            idx.index_file(&format!("note{i}.md"), i * 1000);
        }
        let results = idx.recent(3);
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].path, "note9.md");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_file_disappears_from_results() {
        let (idx, dir) = make_idx("remove");
        idx.index_file("keep.md", 1000);
        idx.index_file("delete-me.md", 2000);
        // Commit so delete_term in the next batch affects committed docs
        idx.commit();
        idx.remove_file("delete-me.md");
        assert!(idx.search_names("delete", 10).is_empty());
        let recent = idx.recent(10);
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].path, "keep.md");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn index_file_updates_mtime() {
        let (idx, dir) = make_idx("update_mtime");
        idx.index_file("note.md", 1000);
        idx.index_file("other.md", 500);
        // Commit so the subsequent delete_term removes the committed "note.md"
        idx.commit();
        idx.index_file("note.md", 9000);
        let results = idx.recent(10);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].path, "note.md");
        assert_eq!(results[0].mtime, 9000);
        let _ = fs::remove_dir_all(&dir);
    }
}
