use std::{fs, path::Path};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "default_weight_title")]
    pub weight_title: f32,
    #[serde(default = "default_weight_headings")]
    pub weight_headings: f32,
    #[serde(default = "default_weight_tags")]
    pub weight_tags: f32,
    #[serde(default = "default_weight_content")]
    pub weight_content: f32,
    #[serde(default = "default_fuzzy_distance")]
    pub fuzzy_distance: u8,
    #[serde(default = "default_result_limit")]
    pub result_limit: usize,
    #[serde(default = "default_show_score_breakdown")]
    pub show_score_breakdown: bool,
    #[serde(default)]
    pub excluded_folders: Vec<String>,
}

fn default_weight_title() -> f32 { 10.0 }
fn default_weight_headings() -> f32 { 5.0 }
fn default_weight_tags() -> f32 { 2.0 }
fn default_weight_content() -> f32 { 1.0 }
fn default_fuzzy_distance() -> u8 { 1 }
fn default_result_limit() -> usize { 20 }
fn default_show_score_breakdown() -> bool { true }

impl Default for Settings {
    fn default() -> Self {
        Self {
            weight_title: default_weight_title(),
            weight_headings: default_weight_headings(),
            weight_tags: default_weight_tags(),
            weight_content: default_weight_content(),
            fuzzy_distance: default_fuzzy_distance(),
            result_limit: default_result_limit(),
            show_score_breakdown: default_show_score_breakdown(),
            excluded_folders: Vec::new(),
        }
    }
}

impl Settings {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join(".tansu/settings.json");
        match fs::read_to_string(&path) {
            Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        let path = dir.join(".tansu/settings.json");
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
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
        assert_eq!(s.weight_tags, 2.0);
        assert_eq!(s.weight_content, 1.0);
        assert_eq!(s.fuzzy_distance, 1);
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
        let s = Settings { weight_title: 8.0, ..Default::default() };
        let json = serde_json::to_string(&s).unwrap();
        let s2: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(s2.weight_title, 8.0);
    }
}
