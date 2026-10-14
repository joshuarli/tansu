use tantivy::TantivyDocument;
use tantivy::schema::*;

#[derive(Debug, Clone)]
pub(crate) struct FieldHandles {
    pub note_id: Field,
    pub path: Field,
    pub title: Field,
    pub headings: Field,
    pub tags: Field,
    pub content: Field,
    pub revision: Field,
    pub source_hash: Field,
}

impl FieldHandles {
    pub fn text_fields(&self) -> [(&'static str, Field); 5] {
        [
            ("title", self.title),
            ("path", self.path),
            ("headings", self.headings),
            ("tags", self.tags),
            ("content", self.content),
        ]
    }
}

pub(crate) fn build_schema() -> (Schema, FieldHandles) {
    let mut builder = Schema::builder();
    let note_id = builder.add_text_field("noteId", STRING | STORED);
    let path = builder.add_text_field("path", searchable_stored());
    let title = builder.add_text_field("title", searchable_stored());
    let headings = builder.add_text_field("headings", searchable_stored());
    let tags = builder.add_text_field("tags", searchable_stored());
    let content = builder.add_text_field("content", searchable_stored());
    let revision = builder.add_u64_field("revision", STORED | FAST);
    let source_hash = builder.add_text_field("sourceHash", STRING | STORED);
    (
        builder.build(),
        FieldHandles {
            note_id,
            path,
            title,
            headings,
            tags,
            content,
            revision,
            source_hash,
        },
    )
}

fn searchable_stored() -> TextOptions {
    let indexing = TextFieldIndexing::default()
        .set_tokenizer("ferrisearch")
        .set_index_option(IndexRecordOption::WithFreqsAndPositions)
        .set_fieldnorms(false);
    TextOptions::default()
        .set_indexing_options(indexing)
        .set_stored()
}

pub(crate) fn doc_text(doc: &TantivyDocument, field: Field) -> String {
    doc.get_first(field)
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_contains_only_note_search_data() {
        let (schema, fields) = build_schema();
        for name in [
            "noteId",
            "path",
            "title",
            "headings",
            "tags",
            "content",
            "revision",
            "sourceHash",
        ] {
            assert!(schema.get_field(name).is_ok(), "missing field: {name}");
        }
        for removed in ["aliases", "basename", "mtime", "directory"] {
            assert!(schema.get_field(removed).is_err(), "unexpected field: {removed}");
        }
        assert_eq!(fields.note_id, schema.get_field("noteId").unwrap());
        assert_eq!(fields.content, schema.get_field("content").unwrap());
        assert_eq!(fields.revision, schema.get_field("revision").unwrap());
        assert_eq!(fields.source_hash, schema.get_field("sourceHash").unwrap());
    }

    #[test]
    fn query_fields_match_fixed_search_weights() {
        let (_, fields) = build_schema();
        assert_eq!(
            fields
                .text_fields()
                .map(|(name, _)| name)
                .as_slice(),
            ["title", "path", "headings", "tags", "content"]
        );
    }
}
