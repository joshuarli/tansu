include!(concat!(env!("OUT_DIR"), "/embedded_assets.rs"));

pub fn get(path: &str) -> Option<&'static EmbeddedAsset> {
    let path = path.split_once('?').map_or(path, |(path, _)| path);
    if !path.starts_with('/') || path.contains(['%', '\\']) {
        return None;
    }
    ASSETS.iter().find(|asset| asset.url == path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_only_manifest_assets() {
        let shell = get("/").unwrap();
        assert_eq!(shell.content_type, "text/html; charset=utf-8");
        assert!(!shell.immutable);
        assert!(get("/../Cargo.toml").is_none());
        assert!(get("/%2e%2e/Cargo.toml").is_none());
        assert!(get("/assets/app.js").is_none());
        assert!(get("/assets/not-shipped.js").is_none());
        assert!(ASSETS.iter().all(|asset| !asset.url.ends_with(".map")));
        assert!(ASSETS.iter().filter(|asset| asset.url.starts_with("/assets/")).all(|asset| asset.immutable));
    }
}
