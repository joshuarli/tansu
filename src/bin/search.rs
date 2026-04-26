use std::{
    env, fs,
    path::{Path, PathBuf},
    process,
    time::{SystemTime, UNIX_EPOCH},
};

use tansu::{index::Index, settings::Settings};

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    let cli = Cli::parse(&args)?;

    let notes_dir = fs::canonicalize(&cli.notes_dir).map_err(|err| {
        format!(
            "canonicalizing notes dir {}: {err}",
            cli.notes_dir.display()
        )
    })?;
    if !notes_dir.is_dir() {
        return Err(format!(
            "notes dir is not a directory: {}",
            notes_dir.display()
        ));
    }

    let settings = Settings::load(&notes_dir);
    let limit = cli.limit.unwrap_or(settings.result_limit);
    let fuzzy = cli.fuzzy.unwrap_or(settings.fuzzy_distance);
    let weights = settings.weights();

    let temp_index = TempIndexDir::new()?;
    let idx = Index::open_or_create(temp_index.path())
        .map_err(|err| format!("opening temp index {}: {err}", temp_index.path().display()))?;
    idx.full_reindex(&notes_dir, &settings.excluded_folders);

    let results = idx.search(
        &cli.query,
        limit,
        None,
        fuzzy,
        settings.recency_boost,
        weights,
        settings.show_score_breakdown,
    );
    print_results(&results);

    Ok(())
}

struct Cli {
    notes_dir: PathBuf,
    query: String,
    limit: Option<usize>,
    fuzzy: Option<u8>,
}

impl Cli {
    fn parse(args: &[String]) -> Result<Self, String> {
        if args.is_empty() || args.iter().any(|arg| arg == "-h" || arg == "--help") {
            return Err(Self::usage());
        }
        if args.len() < 2 {
            return Err(format!("missing required arguments\n\n{}", Self::usage()));
        }

        let notes_dir = PathBuf::from(&args[0]);
        let query = args[1].clone();
        let mut limit = None;
        let mut fuzzy = None;

        let mut i = 2;
        while i < args.len() {
            match args[i].as_str() {
                "--limit" => {
                    i += 1;
                    let value = args
                        .get(i)
                        .ok_or_else(|| "--limit requires a value".to_string())?;
                    limit = Some(
                        value
                            .parse()
                            .map_err(|_| format!("invalid --limit value: {value}"))?,
                    );
                }
                "--fuzzy" => {
                    i += 1;
                    let value = args
                        .get(i)
                        .ok_or_else(|| "--fuzzy requires a value".to_string())?;
                    fuzzy = Some(
                        value
                            .parse()
                            .map_err(|_| format!("invalid --fuzzy value: {value}"))?,
                    );
                }
                other => {
                    return Err(format!("unknown argument: {other}\n\n{}", Self::usage()));
                }
            }
            i += 1;
        }

        if query.trim().is_empty() {
            return Err("query must not be empty".to_string());
        }

        Ok(Self {
            notes_dir,
            query,
            limit,
            fuzzy,
        })
    }

    fn usage() -> String {
        "usage: cargo run --bin search -- <notes-dir> <query> [--limit N] [--fuzzy N]".to_string()
    }
}

struct TempIndexDir {
    path: PathBuf,
}

impl TempIndexDir {
    fn new() -> Result<Self, String> {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|err| format!("reading system clock: {err}"))?
            .as_millis();
        let path = env::temp_dir().join(format!("tansu-search-{}-{millis}", process::id()));
        fs::create_dir_all(&path)
            .map_err(|err| format!("creating temp index dir {}: {err}", path.display()))?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempIndexDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn print_results(results: &[tansu::index::SearchResult]) {
    for (i, result) in results.iter().enumerate() {
        if i > 0 {
            println!();
        }
        println!("{}", result.title);
        println!("{}", result.path);
        println!(
            "{:.3} = {}",
            result.score,
            format_field_scores(&result.field_scores)
        );
        println!("{}", result.excerpt);
    }
}

fn format_field_scores(scores: &tansu::index::FieldScores) -> String {
    let mut parts = Vec::new();
    for (name, value) in [
        ("title", scores.title),
        ("headings", scores.headings),
        ("tags", scores.tags),
        ("content", scores.content),
    ] {
        if value > 0.0 {
            parts.push(format!("{name}:{}", format_field_score(value)));
        }
    }
    if parts.is_empty() {
        "no field matches".to_string()
    } else {
        parts.join(" ")
    }
}

fn format_field_score(value: f32) -> String {
    if value >= 1.0 {
        format!("{value:.2}")
    } else {
        format!("{value:.3}")
    }
}
