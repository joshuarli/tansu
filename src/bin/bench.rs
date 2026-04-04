use std::{env, fs, path::Path, time::Instant};

use tansu::index::Index;
use tansu::settings::Settings;

fn main() {
    let dir = env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: bench <notes-dir>");
        std::process::exit(1);
    });
    let dir = fs::canonicalize(&dir).expect("invalid directory");
    let index_dir = dir.join(".tansu/index");

    if !index_dir.exists() {
        eprintln!(
            "No index at {}. Run the server first to create it.",
            index_dir.display()
        );
        std::process::exit(1);
    }

    let settings = Settings::load(&dir);
    let weights = settings.weights();
    let fuzzy = settings.fuzzy_distance;
    let limit = settings.result_limit;

    println!("vault: {} ({} notes)", dir.display(), count_md_files(&dir));
    println!(
        "index: {} ({})",
        index_dir.display(),
        human_size(&index_dir)
    );
    println!("settings: weights={weights:?} fuzzy={fuzzy} limit={limit}");
    println!();

    let idx = Index::open_or_create(&index_dir).expect("failed to open index");

    // Warm up reader
    idx.search("warmup", limit, None, fuzzy, weights, false);

    // 1. get_all_notes
    bench("get_all_notes", 50, || {
        let notes = idx.get_all_notes();
        std::hint::black_box(notes.len());
    });

    // 2. Search: common terms
    let common_queries = ["the", "rust", "linux", "note", "project", "config"];
    for q in common_queries {
        let label = format!("search exact '{q}'");
        bench(&label, 100, || {
            let r = idx.search(q, limit, None, fuzzy, weights, false);
            std::hint::black_box(r.len());
        });
    }

    // 3. Search: typo queries (exercises fuzzy phase)
    let fuzzy_queries = ["linuxx", "projecr", "rustlang", "confg"];
    for q in fuzzy_queries {
        let label = format!("search fuzzy '{q}'");
        bench(&label, 100, || {
            let r = idx.search(q, limit, None, fuzzy, weights, false);
            std::hint::black_box(r.len());
        });
    }

    // 4. Search: multi-term
    let multi = ["rust async", "linux kernel config", "project plan"];
    for q in multi {
        let label = format!("search multi '{q}'");
        bench(&label, 100, || {
            let r = idx.search(q, limit, None, fuzzy, weights, false);
            std::hint::black_box(r.len());
        });
    }

    // 5. Search: no results (worst case — runs both phases)
    bench("search miss 'xyzzyplugh'", 100, || {
        let r = idx.search("xyzzyplugh", limit, None, fuzzy, weights, false);
        std::hint::black_box(r.len());
    });

    // 6. get_backlinks for a common stem
    let notes = idx.get_all_notes();
    if let Some(note) = notes.first() {
        let stem = Path::new(&note.path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&note.path);
        let label = format!("get_backlinks '{stem}'");
        bench(&label, 100, || {
            let r = idx.get_backlinks(stem);
            std::hint::black_box(r.len());
        });
    }

    // 7. Index a single note (add_doc + commit)
    let sample_note = notes.iter().find(|n| dir.join(&n.path).is_file());
    if let Some(note) = sample_note {
        let full = dir.join(&note.path);
        let content = fs::read_to_string(&full).unwrap_or_default();
        let content_len = content.len();
        let label = format!("index_note ({content_len} bytes)");
        bench(&label, 20, || {
            idx.index_note(&note.path, &content, &full);
        });
    }

    // 8. Full reindex
    let excluded = settings.excluded_folders.clone();
    bench("full_reindex", 3, || {
        idx.full_reindex(&dir, &excluded);
    });
}

fn bench(label: &str, iters: u32, mut f: impl FnMut()) {
    // Warmup
    f();

    let mut times = Vec::with_capacity(iters as usize);
    for _ in 0..iters {
        let start = Instant::now();
        f();
        times.push(start.elapsed());
    }
    times.sort();

    let total: std::time::Duration = times.iter().sum();
    let avg = total / iters;
    let p50 = times[times.len() / 2];
    let p99 = times[(times.len() as f64 * 0.99) as usize];
    let min = times[0];
    let max = times[times.len() - 1];

    println!(
        "{label:40} avg={:>8.2}ms  p50={:>8.2}ms  p99={:>8.2}ms  min={:>8.2}ms  max={:>8.2}ms  (n={iters})",
        avg.as_secs_f64() * 1000.0,
        p50.as_secs_f64() * 1000.0,
        p99.as_secs_f64() * 1000.0,
        min.as_secs_f64() * 1000.0,
        max.as_secs_f64() * 1000.0,
    );
}

fn count_md_files(dir: &Path) -> usize {
    let mut count = 0;
    walk(dir, &mut count);
    fn walk(dir: &Path, count: &mut usize) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if path.is_dir() {
                if !name_str.starts_with('.') && name_str != "z-images" {
                    walk(&path, count);
                }
            } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
                *count += 1;
            }
        }
    }
    count
}

fn human_size(dir: &Path) -> String {
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            if let Ok(m) = entry.metadata() {
                total += m.len();
            }
        }
    }
    if total > 1_000_000 {
        format!("{:.1}MB", total as f64 / 1_000_000.0)
    } else if total > 1_000 {
        format!("{:.1}KB", total as f64 / 1_000.0)
    } else {
        format!("{total}B")
    }
}
