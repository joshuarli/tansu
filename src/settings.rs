use std::{fs, path::Path};

use crate::index::SearchWeights;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(default)]
pub struct Settings {
    pub weight_title: f32,
    pub weight_headings: f32,
    pub weight_tags: f32,
    pub weight_content: f32,
    pub fuzzy_distance: u8,
    pub recency_boost: u8,
    pub result_limit: usize,
    pub show_score_breakdown: bool,
    pub excluded_folders: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            weight_title: 10.0,
            weight_headings: 5.0,
            weight_tags: 25.0,
            weight_content: 1.0,
            fuzzy_distance: 1,
            recency_boost: 2,
            result_limit: 20,
            show_score_breakdown: true,
            excluded_folders: Vec::new(),
        }
    }
}

impl Settings {
    pub fn weights(&self) -> SearchWeights {
        SearchWeights {
            title: self.weight_title,
            headings: self.weight_headings,
            tags: self.weight_tags,
            content: self.weight_content,
        }
    }

    pub fn load(dir: &Path) -> Self {
        let path = dir.join(".tansu/settings.json");
        match fs::read_to_string(&path) {
            Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        let path = dir.join(".tansu/settings.json");
        let json =
            serde_json::to_string_pretty(self).map_err(|e| std::io::Error::other(e.to_string()))?;
        fs::write(path, json)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_values() {
        let s = Settings::default();
        assert_eq!(s.weight_title, 10.0);
        assert_eq!(s.weight_headings, 5.0);
        assert_eq!(s.weight_tags, 25.0);
        assert_eq!(s.weight_content, 1.0);
        assert_eq!(s.fuzzy_distance, 1);
        assert_eq!(s.recency_boost, 2);
        assert_eq!(s.result_limit, 20);
        assert!(s.show_score_breakdown);
        assert!(s.excluded_folders.is_empty());
    }

    #[test]
    fn deserialize_partial() {
        let json = r#"{"weight_title": 15.0}"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(s.weight_title, 15.0);
        assert_eq!(s.weight_headings, 5.0); // default
    }

    #[test]
    fn round_trip() {
        let s = Settings {
            weight_title: 8.0,
            ..Default::default()
        };
        let json = serde_json::to_string(&s).unwrap();
        let s2: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s2.weight_title, 8.0);
    }
}
