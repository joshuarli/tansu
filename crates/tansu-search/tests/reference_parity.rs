use tansu_search::{
    DocumentInput, Fuzziness, NoteIdentity, SearchLimit, SearchOptions, SearchService,
};

struct Note {
    id: &'static str,
    path: &'static str,
    title: &'static str,
    headings: &'static str,
    content: &'static str,
    tags: &'static [&'static str],
}

#[test]
fn port_matches_the_pinned_reference_candidate_golden() {
    let notes = [
        Note {
            id: "apple",
            path: "recipe/apple.md",
            title: "Apple Tart",
            headings: "Fruit",
            content: "Butter sugar tart with a crisp crust.",
            tags: &["dessert"],
        },
        Note {
            id: "guide",
            path: "manual/start.md",
            title: "Guide",
            headings: "Quick Start",
            content: "The quick brown fox jumps over the lazy dog. Cafe\u{301} au lait.",
            tags: &[],
        },
        Note {
            id: "typo",
            path: "misc/typo.md",
            title: "Odd",
            headings: "",
            content: "The quick brown fox ate pwoder.",
            tags: &[],
        },
        Note {
            id: "powder",
            path: "reference/exact.md",
            title: "Powder milk",
            headings: "Ingredients",
            content: "Powder and milk.",
            tags: &["pantry"],
        },
        Note {
            id: "desserts",
            path: "desserts.md",
            title: "Saved recipes",
            headings: "Favorites",
            content: "A rich chocolate tart and apple crumble.",
            tags: &["dessert"],
        },
        Note {
            id: "alias-only",
            path: "archive/alias.md",
            title: "Unrelated",
            headings: "",
            content: "Nothing searchable here.",
            tags: &[],
        },
    ];
    let identities = notes
        .iter()
        .map(|note| {
            NoteIdentity::new(
                note.id.into(),
                note.path.into(),
                note.title.into(),
                note.tags.iter().map(|tag| (*tag).into()).collect(),
                1,
                "blake3-v3:fixture".into(),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    let documents = notes
        .iter()
        .zip(identities.iter())
        .map(|(note, identity)| {
            DocumentInput::new(identity.clone(), note.content.into(), note.headings.into()).unwrap()
        })
        .collect::<Vec<_>>();
    let directory = tempfile::tempdir().unwrap();
    let mut service = SearchService::open(&directory.path().join("search")).unwrap();
    service.rebuild(documents).unwrap();
    let options = SearchOptions::new(
        tansu_search::SearchMode::ExactPrefix,
        Fuzziness::OneEdit,
        SearchLimit::try_from(10).unwrap(),
    )
    .unwrap();

    for (query, expected) in [
        ("apple", vec![("apple", 46.10177), ("desserts", 3.750022)]),
        ("tart", vec![("apple", 28.807467), ("desserts", 2.9707336)]),
        ("quick", vec![("guide", 14.090438), ("typo", 2.9707336)]),
        ("\"quick brown\"", vec![("guide", 3.1414669), ("typo", 3.1414669)]),
        ("powd", vec![("powder", 8.8)]),
        ("pwoder", vec![("typo", 3.750022), ("powder", 0.6)]),
        ("café", vec![("guide", 3.750022)]),
        ("dessert", vec![("desserts", 8.661395), ("apple", 3.0613954)]),
    ] {
        let hits = service.search(query.into(), options, identities.clone()).unwrap();
        assert_eq!(hits.len(), expected.len(), "query: {query:?}");
        for (hit, (id, score)) in hits.iter().zip(expected) {
            assert_eq!(hit.note_id, id, "query: {query:?}");
            assert!((hit.score - score).abs() < 0.0001, "query: {query:?}, score: {}", hit.score);
        }
    }

    for line in include_str!("goldens/reference-parity.tsv").lines().skip(1) {
        let fields = line.split('\t').collect::<Vec<_>>();
        assert_eq!(fields.len(), 3);
        let mut actual = service
            .search(fields[0].into(), options, identities.clone())
            .unwrap()
            .into_iter()
            .map(|hit| hit.note_id)
            .collect::<Vec<_>>();
        actual.sort();
        let expected = if fields[2] == "-" {
            Vec::new()
        } else {
            fields[2].split(',').map(str::to_owned).collect()
        };
        assert_eq!(actual, expected, "query: {}", fields[0]);
    }
}
