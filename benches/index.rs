use std::{
    alloc::{GlobalAlloc, Layout, System},
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering::Relaxed},
};

use criterion::{Criterion, black_box, criterion_group, criterion_main};
use tansu::index::{Index, SearchWeights};
use tansu::settings::Settings;

struct CountingAlloc;

static ALLOC_COUNT: AtomicU64 = AtomicU64::new(0);
static ALLOC_BYTES: AtomicU64 = AtomicU64::new(0);
static FREE_COUNT: AtomicU64 = AtomicU64::new(0);
static FREE_BYTES: AtomicU64 = AtomicU64::new(0);

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOC_COUNT.fetch_add(1, Relaxed);
        ALLOC_BYTES.fetch_add(layout.size() as u64, Relaxed);
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        FREE_COUNT.fetch_add(1, Relaxed);
        FREE_BYTES.fetch_add(layout.size() as u64, Relaxed);
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

struct AllocSnapshot {
    count: u64,
    bytes: u64,
    frees: u64,
    free_bytes: u64,
}

fn alloc_snapshot() -> AllocSnapshot {
    AllocSnapshot {
        count: ALLOC_COUNT.load(Relaxed),
        bytes: ALLOC_BYTES.load(Relaxed),
        frees: FREE_COUNT.load(Relaxed),
        free_bytes: FREE_BYTES.load(Relaxed),
    }
}

fn alloc_delta(before: &AllocSnapshot) -> (u64, u64, i64) {
    let after = alloc_snapshot();
    let allocs = after.count - before.count;
    let bytes = after.bytes - before.bytes;
    let net = (after.bytes - after.free_bytes) as i64 - (before.bytes - before.free_bytes) as i64;
    (allocs, bytes, net)
}

fn vault_dir() -> PathBuf {
    let dir = std::env::var("TANSU_BENCH_DIR").unwrap_or_else(|_| {
        let home = std::env::var("HOME").expect("HOME not set");
        format!("{home}/notes")
    });
    fs::canonicalize(&dir).expect("TANSU_BENCH_DIR or ~/notes must exist")
}

fn setup() -> (Index, Settings, PathBuf) {
    let dir = vault_dir();
    let index_dir = dir.join(".tansu/index");
    assert!(
        index_dir.exists(),
        "No index at {}. Run the server first.",
        index_dir.display()
    );
    let settings = Settings::load(&dir);
    let idx = Index::open_or_create(&index_dir).expect("failed to open index");
    // Warm up
    idx.search(
        "warmup",
        20,
        None,
        settings.fuzzy_distance,
        settings.weights(),
        false,
    );
    (idx, settings, dir)
}

fn bench_get_all_notes(c: &mut Criterion) {
    let (idx, _, _) = setup();

    // Alloc report (single iteration)
    let snap = alloc_snapshot();
    let notes = idx.get_all_notes();
    let (allocs, bytes, net) = alloc_delta(&snap);
    eprintln!(
        "get_all_notes: {} notes, {} allocs, {} bytes total, {} bytes net",
        notes.len(),
        allocs,
        bytes,
        net
    );

    c.bench_function("get_all_notes", |b| {
        b.iter(|| {
            let notes = idx.get_all_notes();
            black_box(notes.len());
        });
    });
}

fn bench_index_note(c: &mut Criterion) {
    let (idx, _, dir) = setup();
    let notes = idx.get_all_notes();

    let sample = notes.iter().find(|n| dir.join(&n.path).is_file());
    let Some(note) = sample else {
        eprintln!("no sample note found, skipping index_note bench");
        return;
    };
    let full = dir.join(&note.path);
    let content = fs::read_to_string(&full).unwrap_or_default();

    // Alloc report
    let snap = alloc_snapshot();
    idx.index_note(&note.path, &content, &full);
    let (allocs, bytes, net) = alloc_delta(&snap);
    eprintln!(
        "index_note ({} bytes): {} allocs, {} bytes total, {} bytes net",
        content.len(),
        allocs,
        bytes,
        net
    );

    let path = &note.path;
    c.bench_function(&format!("index_note ({} bytes)", content.len()), |b| {
        b.iter(|| {
            idx.index_note(black_box(path), black_box(&content), black_box(&full));
        });
    });

    // Realistic workflow: write then immediately search (commit cost lands here)
    let weights = SearchWeights {
        title: 10.0,
        headings: 5.0,
        tags: 2.0,
        content: 1.0,
    };
    c.bench_function("index_note + search (write-read cycle)", |b| {
        b.iter(|| {
            idx.index_note(black_box(path), black_box(&content), black_box(&full));
            let r = idx.search(black_box("the"), 20, None, 1, weights, false);
            black_box(r.len());
        });
    });
}

fn bench_search(c: &mut Criterion) {
    let (idx, settings, _) = setup();
    let weights = settings.weights();
    let fuzzy = settings.fuzzy_distance;
    let limit = settings.result_limit;

    let queries = [
        ("exact 'the'", "the"),
        ("exact 'note'", "note"),
        ("exact 'rust'", "rust"),
        ("fuzzy 'projecr'", "projecr"),
        ("multi 'project plan'", "project plan"),
        ("miss 'xyzzyplugh'", "xyzzyplugh"),
    ];

    for (label, q) in queries {
        // Alloc report
        let snap = alloc_snapshot();
        let results = idx.search(q, limit, None, fuzzy, weights, false);
        let (allocs, bytes, net) = alloc_delta(&snap);
        eprintln!(
            "search {label}: {} results, {} allocs, {} bytes total, {} bytes net",
            results.len(),
            allocs,
            bytes,
            net
        );

        c.bench_function(&format!("search {label}"), |b| {
            b.iter(|| {
                let r = idx.search(black_box(q), limit, None, fuzzy, weights, false);
                black_box(r.len());
            });
        });
    }
}

criterion_group!(benches, bench_get_all_notes, bench_index_note, bench_search);
criterion_main!(benches);
