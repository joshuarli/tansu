use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    time::Duration,
};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher, Config};

pub enum WatchEvent {
    Modified(PathBuf),
    Created(PathBuf),
    Removed(PathBuf),
}

pub fn start_watcher(
    dir: &Path,
    tx: mpsc::Sender<WatchEvent>,
    self_writes: Arc<Mutex<HashSet<PathBuf>>>,
) -> notify::Result<RecommendedWatcher> {
    let dir_owned = dir.to_path_buf();
    let dir_for_watch = dir.to_path_buf();

    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            let dir = &dir_owned;
            let Ok(event) = res else { return };

            for path in &event.paths {
                // Only watch .md files
                let is_md = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"));
                if !is_md {
                    continue;
                }

                // Ignore .tansu/ directory
                if path.starts_with(dir.join(".tansu")) {
                    continue;
                }

                // Check self-write filter
                {
                    let mut sw = self_writes.lock().unwrap();
                    if sw.remove(path) {
                        continue;
                    }
                }

                let evt = match event.kind {
                    EventKind::Create(_) => WatchEvent::Created(path.clone()),
                    EventKind::Modify(_) => WatchEvent::Modified(path.clone()),
                    EventKind::Remove(_) => WatchEvent::Removed(path.clone()),
                    _ => continue,
                };
                let _ = tx.send(evt);
            }
        },
        Config::default().with_poll_interval(Duration::from_secs(2)),
    )?;

    watcher.watch(&dir_for_watch, RecursiveMode::Recursive)?;
    Ok(watcher)
}
