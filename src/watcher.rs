use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};

use crate::util;
use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

pub enum WatchEvent {
    Modified(PathBuf),
    Created(PathBuf),
    Removed(PathBuf),
}

const SELF_WRITE_WINDOW: Duration = Duration::from_secs(2);

pub fn start_watcher(
    dir: &Path,
    tx: mpsc::Sender<WatchEvent>,
    self_writes: Arc<Mutex<HashMap<PathBuf, Instant>>>,
) -> notify::Result<RecommendedWatcher> {
    let dir_owned = dir.to_path_buf();
    let dir_for_watch = dir.to_path_buf();

    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            let dir = &dir_owned;
            let Ok(event) = res else { return };

            for path in &event.paths {
                if !util::is_markdown(path) {
                    continue;
                }

                // Ignore .tansu/ directory
                if path.starts_with(dir.join(".tansu")) {
                    continue;
                }

                // Check self-write filter: suppress events within the window of our own writes.
                {
                    let mut sw = self_writes.lock().unwrap();
                    if let Some(&ts) = sw.get(path) {
                        if ts.elapsed() < SELF_WRITE_WINDOW {
                            continue;
                        }
                        sw.remove(path);
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
