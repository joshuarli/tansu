use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[test]
fn corpus_loader_copies_source_cases_to_work_without_round_tripping_bytes() {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR"));
    let source = repository.join("tests/fixtures/source-fidelity");
    let work = repository.join(".work/tmp");
    fs::create_dir_all(&work).unwrap();
    let source_files = files_under(&source).unwrap();
    let original_bytes: Vec<_> = source_files
        .iter()
        .map(|relative| (relative.clone(), fs::read(source.join(relative)).unwrap()))
        .collect();
    let copy = tempfile::Builder::new()
        .prefix("source-fidelity-")
        .tempdir_in(&work)
        .unwrap();
    copy_tree(&source, copy.path()).unwrap();

    let copied_files = files_under(copy.path()).unwrap();
    assert_eq!(source_files, copied_files);
    for (relative, expected) in &original_bytes {
        assert_eq!(
            fs::read(source.join(relative)).unwrap(),
            *expected,
            "source fixture changed while loading {relative:?}"
        );
        assert_eq!(
            fs::read(copy.path().join(relative)).unwrap(),
            *expected,
            "fixture bytes changed while loading {relative:?}"
        );
    }

    let required = [
        "notes/blank-geometry.md",
        "notes/bom-crlf.md",
        "notes/callouts.md",
        "notes/crlf.md",
        "notes/duplicate-title-a.md",
        "notes/duplicate-title-b.md",
        "notes/escaped-delimiters.md",
        "notes/fenced-hash.md",
        "notes/identical-content-a.md",
        "notes/identical-content-b.md",
        "notes/large-source.md",
        "notes/links.md",
        "notes/mixed-endings.md",
        "notes/mixed-frontmatter.md",
        "notes/nested/deeper/nested-note.md",
        "notes/table.md",
        "notes/unusual-list-indentation.md",
        "notes/unsupported-frontmatter.md",
        "notes/unicode-emoji.md",
        "notes/wiki-embeds.md",
        "mutations/missing-snapshot.md",
        "mutations/stale-base.md",
        "mutations/stale-draft.md",
        "snapshots/corrupt.lz4",
    ];
    for relative in required {
        assert!(copied_files.contains(&PathBuf::from(relative)), "missing {relative}");
    }

    let blank = fs::read(copy.path().join("notes/blank-geometry.md")).unwrap();
    assert!(blank.starts_with(b"\n\n"));
    assert!(blank.ends_with(b"\n\n\n"));

    let bom = fs::read(copy.path().join("notes/bom-crlf.md")).unwrap();
    assert!(bom.starts_with(&[0xef, 0xbb, 0xbf]));

    let crlf = fs::read(copy.path().join("notes/crlf.md")).unwrap();
    assert!(crlf.windows(2).any(|pair| pair == b"\r\n"));
    assert!(!crlf.iter().enumerate().any(|(index, byte)| {
        *byte == b'\n' && (index == 0 || crlf[index - 1] != b'\r')
    }));

    let mixed = fs::read(copy.path().join("notes/mixed-endings.md")).unwrap();
    assert!(mixed.windows(2).any(|pair| pair == b"\r\n"));
    assert!(mixed.iter().enumerate().any(|(index, byte)| {
        *byte == b'\n' && (index == 0 || mixed[index - 1] != b'\r')
    }));

    let large = fs::metadata(copy.path().join("notes/large-source.md")).unwrap();
    assert!(large.len() > 50_000);
    assert_eq!(
        fs::read(copy.path().join("notes/identical-content-a.md")).unwrap(),
        fs::read(copy.path().join("notes/identical-content-b.md")).unwrap()
    );
    let duplicate_title_a = fs::read(copy.path().join("notes/duplicate-title-a.md")).unwrap();
    let duplicate_title_b = fs::read(copy.path().join("notes/duplicate-title-b.md")).unwrap();
    assert_eq!(
        duplicate_title_a.split(|byte| *byte == b'\n').next(),
        duplicate_title_b.split(|byte| *byte == b'\n').next()
    );
    assert!(copy
        .path()
        .join("notes/nested/deeper/nested-note.md")
        .is_file());
    assert!(!copy.path().join("snapshots/missing.lz4").exists());
}

fn copy_tree(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&source_path, &destination_path)?;
        } else {
            fs::copy(source_path, destination_path)?;
        }
    }
    Ok(())
}

fn files_under(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            files.extend(files_under(&path)?.into_iter().map(|child| {
                PathBuf::from(entry.file_name()).join(child)
            }));
        } else {
            files.push(PathBuf::from(entry.file_name()));
        }
    }
    files.sort();
    Ok(files)
}
