use std::{
    collections::{BTreeMap, BTreeSet},
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use crate::crypto::atomic_write;

#[derive(Clone, Default)]
pub struct TagStore {
    path: PathBuf,
    inner: Arc<Mutex<BTreeMap<String, Vec<String>>>>,
}

impl TagStore {
    pub fn open(root: &Path) -> Self {
        let path = root.join(".tansu/tags.json");
        let tags = match fs::read_to_string(&path) {
            Ok(json) => serde_json::from_str::<BTreeMap<String, Vec<String>>>(&json)
                .map(normalize_map)
                .unwrap_or_default(),
            Err(_) => BTreeMap::new(),
        };
        Self {
            path,
            inner: Arc::new(Mutex::new(tags)),
        }
    }

    pub fn get(&self, rel_path: &str) -> Vec<String> {
        self.inner
            .lock()
            .unwrap()
            .get(rel_path)
            .cloned()
            .unwrap_or_default()
    }

    pub fn set(&self, rel_path: &str, tags: &[String]) -> io::Result<Vec<String>> {
        let normalized = normalize_tags(tags.iter().map(String::as_str));
        self.inner
            .lock()
            .unwrap()
            .insert(rel_path.to_string(), normalized.clone());
        self.save()?;
        Ok(normalized)
    }

    pub fn remove(&self, rel_path: &str) -> io::Result<()> {
        self.inner.lock().unwrap().remove(rel_path);
        self.save()
    }

    pub fn rename(&self, old_path: &str, new_path: &str) -> io::Result<()> {
        let tags = self
            .inner
            .lock()
            .unwrap()
            .remove(old_path)
            .unwrap_or_default();
        self.inner
            .lock()
            .unwrap()
            .insert(new_path.to_string(), tags);
        self.save()
    }

    pub fn all_unique(&self) -> Vec<String> {
        let mut set = BTreeSet::new();
        for tags in self.inner.lock().unwrap().values() {
            set.extend(tags.iter().cloned());
        }
        set.into_iter().collect()
    }

    fn save(&self) -> io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_vec_pretty(&*self.inner.lock().unwrap())
            .map_err(|e| io::Error::other(e.to_string()))?;
        atomic_write(&self.path, &json)
    }
}

fn normalize_map(raw: BTreeMap<String, Vec<String>>) -> BTreeMap<String, Vec<String>> {
    raw.into_iter()
        .map(|(path, tags)| (path, normalize_tags(tags.iter().map(String::as_str))))
        .collect()
}

pub fn normalize_tags<'a>(tags: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut set = BTreeSet::new();
    for tag in tags {
        if let Some(normalized) = normalize_tag(tag) {
            set.insert(normalized);
        }
    }
    set.into_iter().collect()
}

pub fn normalize_tag(tag: &str) -> Option<String> {
    let normalized: String = tag
        .chars()
        .filter_map(|ch| {
            let lower = ch.to_ascii_lowercase();
            matches!(lower, 'a'..='z' | '0'..='9' | '_' | '-').then_some(lower)
        })
        .collect();
    (!normalized.is_empty()).then_some(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tansu_tags_{name}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join(".tansu")).unwrap();
        dir
    }

    #[test]
    fn normalize_tag_lowercases_and_drops_invalid_chars() {
        assert_eq!(normalize_tag("Foo/Bar!_1"), Some("foobar_1".to_string()));
        assert_eq!(normalize_tag("!!!"), None);
    }

    #[test]
    fn normalize_tags_dedup_and_sort() {
        let tags = normalize_tags(["Beta", "alpha", "beta", "a/l_p-h a"]);
        assert_eq!(tags, vec!["al_p-ha", "alpha", "beta"]);
    }

    #[test]
    fn store_loads_and_lists_unique_tags() {
        let dir = temp_dir("load_save");
        let store = TagStore::open(&dir);
        let tags = store
            .set(
                "notes/a.md",
                &[
                    "Rust".to_string(),
                    "rust".to_string(),
                    "web-dev".to_string(),
                ],
            )
            .unwrap();
        assert_eq!(tags, vec!["rust", "web-dev"]);
        store
            .set("notes/b.md", &["docs".to_string(), "rust".to_string()])
            .unwrap();

        let reloaded = TagStore::open(&dir);
        assert_eq!(reloaded.get("notes/a.md"), vec!["rust", "web-dev"]);
        assert_eq!(reloaded.all_unique(), vec!["docs", "rust", "web-dev"]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_and_remove_keep_metadata_in_sync() {
        let dir = temp_dir("rename_remove");
        let store = TagStore::open(&dir);
        store
            .set("old.md", &["alpha".to_string(), "beta".to_string()])
            .unwrap();
        store.rename("old.md", "new.md").unwrap();
        assert!(store.get("old.md").is_empty());
        assert_eq!(store.get("new.md"), vec!["alpha", "beta"]);

        store.remove("new.md").unwrap();
        assert!(store.get("new.md").is_empty());

        let _ = fs::remove_dir_all(&dir);
    }
}
