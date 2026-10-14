use std::path::Path;
use std::sync::{Condvar, Mutex};

#[cfg(test)]
use tantivy::collector::Count;
use tantivy::collector::TopDocs;
use tantivy::directory::MmapDirectory;
use tantivy::query::{AllQuery, TermQuery};
use tantivy::schema::{IndexRecordOption, Value};
use tantivy::tokenizer::TokenFilter;
use tantivy::{Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument, Term};

use crate::error::SearchError;
use crate::schema::{FieldHandles, build_schema, doc_text};
use crate::tokenizer::{DiacriticFilter, FerrisearchTokenizer};
use crate::types::{DocumentInput, NoteIdentity};

const SCHEMA_VERSION: u32 = 2;
const ANALYZER_VERSION: u32 = 2;
const MAX_SHARED_WRITER_MEMORY_BUDGET: usize = 64 * 1024 * 1024;
const WRITER_MEMORY_BUDGET: usize = 15_000_000;
const WRITER_COUNT: usize = MAX_SHARED_WRITER_MEMORY_BUDGET / WRITER_MEMORY_BUDGET;

static WRITER_COUNT_IN_USE: Mutex<usize> = Mutex::new(0);
static WRITER_AVAILABLE: Condvar = Condvar::new();

pub(crate) enum IndexMutation {
    Upsert(DocumentInput),
    Delete { note_id: String, revision: i64 },
}

impl IndexMutation {
    pub fn note_id(&self) -> &str {
        match self {
            Self::Upsert(input) => input.note_id(),
            Self::Delete { note_id, .. } => note_id,
        }
    }

    pub fn revision(&self) -> i64 {
        match self {
            Self::Upsert(input) => input.revision(),
            Self::Delete { revision, .. } => *revision,
        }
    }

    pub fn is_delete(&self) -> bool {
        matches!(self, Self::Delete { .. })
    }
}

struct WriterPermit;

impl WriterPermit {
    fn acquire() -> Self {
        let mut active = WRITER_COUNT_IN_USE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while *active >= WRITER_COUNT {
            active = WRITER_AVAILABLE
                .wait(active)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        *active += 1;
        Self
    }
}

impl Drop for WriterPermit {
    fn drop(&mut self) {
        let mut active = WRITER_COUNT_IN_USE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *active -= 1;
        WRITER_AVAILABLE.notify_one();
    }
}

pub(crate) struct IndexManager {
    index: Index,
    writer: Option<(IndexWriter<TantivyDocument>, WriterPermit)>,
    reader: IndexReader,
    fields: FieldHandles,
    watermark: i64,
    metadata_initialized: bool,
}

impl IndexManager {
    pub fn open(path: &Path) -> Result<Self, SearchError> {
        std::fs::create_dir_all(path)?;
        let (schema, fields) = build_schema();
        let directory = MmapDirectory::open(path)?;
        let exists = Index::exists(&directory).map_err(|source| SearchError::IndexOpen {
            source: Box::new(source),
        })?;
        let index = if exists {
            let index = Index::open(directory).map_err(|source| SearchError::IndexOpen {
                source: Box::new(source),
            })?;
            if index.schema() != schema {
                return Err(SearchError::SchemaMismatch);
            }
            index
        } else {
            Index::create_in_dir(path, schema)?
        };
        Self::from_index(index, fields, !exists)
    }

    pub fn new_in_memory() -> Result<Self, SearchError> {
        let (schema, fields) = build_schema();
        Self::from_index(Index::create_in_ram(schema), fields, true)
    }

    fn from_index(
        index: Index,
        fields: FieldHandles,
        allow_missing_metadata: bool,
    ) -> Result<Self, SearchError> {
        index.tokenizers().register(
            "ferrisearch",
            DiacriticFilter.transform(FerrisearchTokenizer::new()),
        );
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()?;
        let (watermark, metadata_initialized) = read_watermark(&index, allow_missing_metadata)?;
        Ok(Self {
            index,
            writer: None,
            reader,
            fields,
            watermark,
            metadata_initialized,
        })
    }

    pub(crate) fn metadata_initialized(&self) -> bool {
        self.metadata_initialized
    }

    fn writer(&mut self) -> Result<&mut IndexWriter<TantivyDocument>, SearchError> {
        if self.writer.is_none() {
            let permit = WriterPermit::acquire();
            let writer = self
                .index
                .writer_with_num_threads(1, WRITER_MEMORY_BUDGET)?;
            self.writer = Some((writer, permit));
        }
        Ok(&mut self.writer.as_mut().unwrap().0)
    }

    #[cfg(test)]
    pub fn upsert(&mut self, input: &DocumentInput) -> Result<bool, SearchError> {
        Ok(self.apply_batch(&[IndexMutation::Upsert(input.clone())])?[0])
    }

    pub fn upsert_batch(&mut self, inputs: &[DocumentInput]) -> Result<(), SearchError> {
        let mutations = inputs
            .iter()
            .cloned()
            .map(IndexMutation::Upsert)
            .collect::<Vec<_>>();
        self.apply_batch(&mutations).map(|_| ())
    }

    #[cfg(test)]
    pub fn remove(&mut self, note_id: &str, revision: i64) -> Result<bool, SearchError> {
        let mutation = IndexMutation::Delete {
            note_id: note_id.to_owned(),
            revision,
        };
        Ok(self.apply_batch(&[mutation])?[0])
    }

    #[cfg(test)]
    pub fn remove_batch(&mut self, removals: &[(String, i64)]) -> Result<(), SearchError> {
        let mutations = removals
            .iter()
            .map(|(note_id, revision)| IndexMutation::Delete {
                note_id: note_id.clone(),
                revision: *revision,
            })
            .collect::<Vec<_>>();
        self.apply_batch(&mutations).map(|_| ())
    }

    pub fn apply_batch(&mut self, mutations: &[IndexMutation]) -> Result<Vec<bool>, SearchError> {
        let fields = self.fields.clone();
        let mut accepted = vec![false; mutations.len()];
        let mut changes = Vec::new();
        for (index, mutation) in mutations.iter().enumerate() {
            let current = self.current_revision(mutation.note_id())?;
            let is_current = match mutation {
                IndexMutation::Upsert(input) => {
                    current.is_none_or(|revision| revision < input.revision())
                }
                IndexMutation::Delete { revision, .. } => {
                    current.is_none_or(|current| current <= *revision)
                }
            };
            if is_current {
                changes.push((index, mutation));
            }
        }
        if changes.is_empty() {
            return Ok(accepted);
        }
        for (index, mutation) in changes {
            match mutation {
                IndexMutation::Upsert(input) => {
                    let document = build_tantivy_doc(&fields, input);
                    let writer = self.writer()?;
                    writer.delete_term(Term::from_field_text(fields.note_id, input.note_id()));
                    writer.add_document(document)?;
                    self.watermark = self.watermark.max(input.revision());
                }
                IndexMutation::Delete { note_id, revision } => {
                    self.writer()?
                        .delete_term(Term::from_field_text(fields.note_id, note_id));
                    self.watermark = self.watermark.max(*revision);
                }
            }
            accepted[index] = true;
        }
        self.commit_no_merge()?;
        Ok(accepted)
    }

    pub fn commit_no_merge(&mut self) -> Result<(), SearchError> {
        if let Some((writer, _)) = self.writer.as_mut() {
            let mut commit = writer.prepare_commit()?;
            commit.set_payload(&watermark_payload(self.watermark));
            commit.commit()?;
            self.reader.reload()?;
            self.metadata_initialized = true;
        }
        Ok(())
    }

    pub fn close_writer(&mut self) {
        self.writer = None;
    }

    pub fn initialize_metadata(&mut self) -> Result<(), SearchError> {
        self.writer()?;
        self.commit_no_merge()
    }

    pub fn reader(&self) -> &IndexReader {
        &self.reader
    }

    pub fn fields(&self) -> &FieldHandles {
        &self.fields
    }

    #[cfg(test)]
    pub fn watermark(&self) -> i64 {
        self.watermark
    }

    pub fn is_current(&self, identities: &[NoteIdentity]) -> Result<bool, SearchError> {
        if self.watermark < identities.iter().map(NoteIdentity::revision).max().unwrap_or(0) {
            return Ok(false);
        }
        let indexed = self.read_identities()?;
        if indexed.len() != identities.len() {
            return Ok(false);
        }
        let current = identities
            .iter()
            .map(|identity| (identity.note_id(), identity))
            .collect::<std::collections::HashMap<_, _>>();
        Ok(indexed.iter().all(|indexed| {
            current
                .get(indexed.note_id())
                .is_some_and(|identity| *identity == indexed)
        }))
    }

    fn read_identities(&self) -> Result<Vec<NoteIdentity>, SearchError> {
        let searcher = self.reader.searcher();
        if searcher.num_docs() == 0 {
            return Ok(Vec::new());
        }
        let docs = searcher.search(
            &AllQuery,
            &TopDocs::with_limit(searcher.num_docs() as usize).order_by_score(),
        )?;
        docs.into_iter()
            .map(|(_, address)| {
                let document = searcher.doc::<TantivyDocument>(address)?;
                let tags = document
                    .get_all(self.fields.tags)
                    .filter_map(|value| value.as_str().map(ToOwned::to_owned))
                    .collect();
                let revision = document
                    .get_first(self.fields.revision)
                    .and_then(|value| value.as_u64())
                    .and_then(|value| i64::try_from(value).ok())
                    .ok_or(SearchError::CorruptIndex)?;
                NoteIdentity::new(
                    doc_text(&document, self.fields.note_id),
                    doc_text(&document, self.fields.path),
                    doc_text(&document, self.fields.title),
                    tags,
                    revision,
                    doc_text(&document, self.fields.source_hash),
                )
            })
            .collect()
    }

    pub fn identities(&self) -> Result<Vec<NoteIdentity>, SearchError> {
        self.read_identities()
    }

    pub fn current_revision(&self, note_id: &str) -> Result<Option<i64>, SearchError> {
        let searcher = self.reader.searcher();
        let term = Term::from_field_text(self.fields.note_id, note_id);
        let matches = searcher.search(
            &TermQuery::new(term, IndexRecordOption::Basic),
            &TopDocs::with_limit(1).order_by_score(),
        )?;
        let Some((_, address)) = matches.first() else {
            return Ok(None);
        };
        let document = searcher.doc::<TantivyDocument>(*address)?;
        document
            .get_first(self.fields.revision)
            .and_then(|value| value.as_u64())
            .and_then(|value| i64::try_from(value).ok())
            .map(Some)
            .ok_or(SearchError::CorruptIndex)
    }

    #[cfg(test)]
    pub fn has_document(&self, note_id: &str) -> Result<bool, SearchError> {
        let searcher = self.reader.searcher();
        let term = Term::from_field_text(self.fields.note_id, note_id);
        let count = searcher.search(&TermQuery::new(term, IndexRecordOption::Basic), &Count)?;
        Ok(count > 0)
    }

    #[cfg(test)]
    pub fn document_count(&self) -> u64 {
        self.reader.searcher().num_docs()
    }
}

fn build_tantivy_doc(fields: &FieldHandles, input: &DocumentInput) -> TantivyDocument {
    let identity = input.identity();
    let mut document = TantivyDocument::default();
    document.add_text(fields.note_id, identity.note_id());
    document.add_text(fields.path, identity.path());
    document.add_text(fields.title, identity.title());
    document.add_text(fields.headings, input.headings());
    for tag in identity.tags() {
        document.add_text(fields.tags, tag);
    }
    document.add_text(fields.content, input.content());
    document.add_u64(fields.revision, identity.revision() as u64);
    document.add_text(fields.source_hash, identity.source_hash());
    document
}

fn read_watermark(index: &Index, allow_missing: bool) -> Result<(i64, bool), SearchError> {
    let Some(payload) = index.load_metas()?.payload else {
        return if allow_missing {
            Ok((0, false))
        } else {
            Err(SearchError::SchemaMismatch)
        };
    };
    let Some(value) = payload
        .strip_prefix("tansu-search;schema=2;analyzer=2;watermark=")
    else {
        return Err(SearchError::SchemaMismatch);
    };
    value
        .parse()
        .map(|watermark| (watermark, true))
        .map_err(|_| SearchError::CorruptIndex)
}

fn watermark_payload(watermark: i64) -> String {
    format!("tansu-search;schema={SCHEMA_VERSION};analyzer={ANALYZER_VERSION};watermark={watermark}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_index_writers_stay_within_shared_memory_budget() {
        assert!(WRITER_MEMORY_BUDGET * WRITER_COUNT <= MAX_SHARED_WRITER_MEMORY_BUDGET);
    }

    fn identity(path: &str, revision: i64) -> NoteIdentity {
        NoteIdentity::new(
            path.trim_end_matches(".md").to_owned(),
            path.to_owned(),
            path.rsplit('/').next().unwrap_or(path).trim_end_matches(".md").to_owned(),
            vec!["tag".to_owned()],
            revision,
            format!("sha256-v2:{revision}"),
        )
        .unwrap()
    }

    fn make_doc(path: &str, content: &str, revision: i64) -> DocumentInput {
        DocumentInput::new(identity(path, revision), content.to_owned(), String::new()).unwrap()
    }

    fn setup_index(docs: &[DocumentInput]) -> IndexManager {
        let mut manager = IndexManager::new_in_memory().unwrap();
        manager.upsert_batch(docs).unwrap();
        manager
    }

    #[test]
    fn path_dir_extraction() {
        let manager = setup_index(&[make_doc("folder/note.md", "body", 1)]);
        assert!(manager.has_document("folder/note").unwrap());
    }

    #[test]
    fn diacritics_disabled() {
        let manager = setup_index(&[make_doc("note.md", "café", 1)]);
        assert!(manager.has_document("note").unwrap());
    }

    #[test]
    fn add_multiple() {
        let docs = [make_doc("a.md", "one", 1), make_doc("b.md", "two", 1)];
        let manager = setup_index(&docs);
        assert_eq!(manager.document_count(), 2);
    }

    #[test]
    fn add_document_with_all_fields() {
        let manager = setup_index(&[make_doc("a.md", "body", 1)]);
        assert_eq!(manager.read_identities().unwrap(), vec![identity("a.md", 1)]);
    }

    #[test]
    fn has_document() {
        let manager = setup_index(&[make_doc("a.md", "body", 1)]);
        assert!(manager.has_document("a").unwrap());
        assert!(!manager.has_document("missing").unwrap());
    }

    #[test]
    fn remove_document() {
        let mut manager = setup_index(&[make_doc("a.md", "body", 1)]);
        manager.remove("a", 2).unwrap();
        assert!(!manager.has_document("a").unwrap());
    }

    #[test]
    fn remove_batch() {
        let docs = [make_doc("a.md", "one", 1), make_doc("b.md", "two", 1)];
        let mut manager = setup_index(&docs);
        manager
            .remove_batch(&[("a".into(), 2), ("b".into(), 2)])
            .unwrap();
        assert_eq!(manager.document_count(), 0);
    }

    #[test]
    fn add_and_count() {
        let manager = setup_index(&[make_doc("a.md", "one", 1), make_doc("b.md", "two", 1)]);
        assert_eq!(manager.document_count(), 2);
    }

    #[test]
    fn remove_nonexistent() {
        let mut manager = setup_index(&[]);
        manager.remove("missing", 1).unwrap();
        assert_eq!(manager.document_count(), 0);
    }

    #[test]
    fn serialize_empty_index() {
        let manager = IndexManager::new_in_memory().unwrap();
        assert_eq!(manager.document_count(), 0);
        assert_eq!(manager.watermark(), 0);
    }

    #[test]
    fn serialize_and_load_blob() {
        let input = identity("a.md", 3);
        let docs = [DocumentInput::new(input, "body".into(), "heading".into()).unwrap()];
        let manager = setup_index(&docs);
        assert!(manager.is_current(&[identity("a.md", 3)]).unwrap());
    }

    #[test]
    fn persist_to_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("search");
        let doc = make_doc("a.md", "body", 1);
        {
            let mut manager = IndexManager::open(&path).unwrap();
            manager.upsert(&doc).unwrap();
        }
        let manager = IndexManager::open(&path).unwrap();
        assert!(manager.has_document("a").unwrap());
        assert_eq!(manager.watermark(), 1);
    }

    #[test]
    fn disk_index_reopen_add_more() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("search");
        {
            let mut manager = IndexManager::open(&path).unwrap();
            manager.upsert(&make_doc("a.md", "one", 1)).unwrap();
        }
        let mut manager = IndexManager::open(&path).unwrap();
        manager.upsert(&make_doc("b.md", "two", 1)).unwrap();
        assert_eq!(manager.document_count(), 2);
    }

    #[test]
    fn upsert() {
        let mut manager = IndexManager::new_in_memory().unwrap();
        manager.upsert(&make_doc("a.md", "one", 1)).unwrap();
        manager.upsert(&make_doc("b.md", "two", 1)).unwrap();
        assert_eq!(manager.document_count(), 2);
    }

    #[test]
    fn upsert_replaces_content() {
        let mut manager = IndexManager::new_in_memory().unwrap();
        manager.upsert(&make_doc("a.md", "one", 1)).unwrap();
        manager.upsert(&make_doc("a.md", "two", 2)).unwrap();
        assert_eq!(manager.document_count(), 1);
        assert_eq!(manager.read_identities().unwrap()[0].revision(), 2);
    }
}
