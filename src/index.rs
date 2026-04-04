use std::{
    fs,
    path::Path,
    sync::{Arc, RwLock},
};

use tantivy::{
    IndexWriter, IndexReader, Index as TantivyIndex, TantivyDocument,
    collector::TopDocs,
    query::{BooleanQuery, FuzzyTermQuery, Occur, TermQuery},
    schema::*,
    snippet::SnippetGenerator,
};

use crate::http;
use crate::scanner;
use crate::strip;

pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub excerpt: String,
    pub score: f32,
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
            }),
        })
    }

    /// Build and add a document to the writer (does not commit).
    fn add_doc(&self, rel_path: &str, content: &str, full_path: &Path) {
        let f = &self.inner.fields;
        let scan = scanner::scan(content);
        let stripped = strip::strip_markdown(content);
        let mtime = http::mtime_secs(full_path);

        let title = if scan.title.is_empty() {
            Path::new(rel_path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(rel_path)
                .to_string()
        } else {
            scan.title
        };

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

    fn commit(&self) {
        let mut writer = self.inner.writer.write().unwrap();
        let _ = writer.commit();
    }

    /// Index a single note and commit immediately.
    pub fn index_note(&self, rel_path: &str, content: &str, full_path: &Path) {
        self.add_doc(rel_path, content, full_path);
        self.commit();
    }

    pub fn remove_note(&self, rel_path: &str) {
        let mut writer = self.inner.writer.write().unwrap();
        let path_term = tantivy::Term::from_field_text(self.inner.fields.path, rel_path);
        writer.delete_term(path_term);
        let _ = writer.commit();
    }

    /// Two-phase search: exact first, fuzzy fallback if <5 results.
    /// If `filter_path` is Some, only return results from that document.
    pub fn search(&self, query: &str, limit: usize, filter_path: Option<&str>) -> Vec<SearchResult> {
        let _ = self.inner.reader.reload();
        let searcher = self.inner.reader.searcher();

        let terms: Vec<&str> = query.split_whitespace().collect();
        if terms.is_empty() {
            return Vec::new();
        }

        // Phase 1: exact
        let phase1_query = self.build_query(&terms, false, filter_path);
        let results = self.execute_search(&searcher, &phase1_query, limit);

        if results.len() >= 5 || filter_path.is_some() {
            return results;
        }

        // Phase 2: add fuzzy
        let phase2_query = self.build_query(&terms, true, filter_path);
        self.execute_search(&searcher, &phase2_query, limit)
    }

    fn build_query(&self, terms: &[&str], fuzzy: bool, filter_path: Option<&str>) -> BooleanQuery {
        let f = &self.inner.fields;
        let search_fields = [
            (f.title, 10.0),
            (f.headings, 5.0),
            (f.tags, 2.0),
            (f.content, 1.0),
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

                if fuzzy && field == f.content {
                    let fuzzy_q = FuzzyTermQuery::new(term, 1, true);
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
    ) -> Vec<SearchResult> {
        let f = &self.inner.fields;
        let Ok(top_docs) = searcher.search(query, &TopDocs::with_limit(limit)) else {
            return Vec::new();
        };

        let snippet_gen = SnippetGenerator::create(searcher, query, f.content).ok();

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
            let excerpt = snippet_gen
                .as_ref()
                .map(|sg| {
                    let snippet = sg.snippet_from_doc(&doc);
                    snippet.to_html()
                })
                .unwrap_or_default();

            results.push(SearchResult {
                path,
                title,
                excerpt,
                score,
            });
        }
        results
    }

    pub fn get_backlinks(&self, target_stem: &str) -> Vec<String> {
        let _ = self.inner.reader.reload();
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
        let _ = self.inner.reader.reload();
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

    /// Full reindex: walk directory, index all .md files. Single commit at end.
    pub fn full_reindex(&self, root: &Path) {
        let start = std::time::Instant::now();
        walk_and_index(root, root, self);
        self.commit();
        fn walk_and_index(root: &Path, dir: &Path, idx: &Index) {
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
                    walk_and_index(root, &path, idx);
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
