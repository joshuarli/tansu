use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

fn main() {
    let dist = Path::new("web/dist");
    let manifest_path = dist.join("manifest.json");
    println!("cargo:rerun-if-changed={}", manifest_path.display());
    let manifest: serde_json::Value = serde_json::from_slice(
        &fs::read(&manifest_path).expect("run `deno task build` before compiling the server"),
    ).expect("web asset manifest must be valid JSON");
    let files = manifest["files"].as_array().expect("web asset manifest requires a files array");
    let mut entries = Vec::with_capacity(files.len());
    let mut listed_paths = BTreeSet::new();
    let mut listed_urls = BTreeSet::new();

    for file in files {
        let url = file["url"].as_str().expect("asset url must be a string");
        let relative = file["file"].as_str().expect("asset file must be a string");
        let content_type = file["contentType"].as_str().expect("asset contentType must be a string");
        let immutable = file["immutable"].as_bool().expect("asset immutable must be a boolean");
        assert!(url.starts_with('/') && !url.contains(['?', '#', '%', '\\']), "invalid asset URL");
        assert!(listed_urls.insert(url.to_string()), "duplicate asset URL");
        let relative_path = Path::new(relative);
        assert!(relative_path.components().all(|component| matches!(component, Component::Normal(_))), "asset path must be relative and confined");
        assert!(listed_paths.insert(relative.to_string()), "duplicate asset file");
        let path = dist.join(relative_path);
        let canonical_dist = fs::canonicalize(dist).expect("web/dist must exist");
        let canonical_path = fs::canonicalize(&path).expect("manifest asset file must exist");
        assert!(canonical_path.starts_with(&canonical_dist), "asset escaped web/dist");
        let actual_content_type = match path.extension().and_then(|extension| extension.to_str()) {
            Some("html") => "text/html; charset=utf-8",
            Some("js") => "text/javascript; charset=utf-8",
            Some("css") => "text/css; charset=utf-8",
            _ => panic!("asset MIME type is not allowed"),
        };
        assert_eq!(content_type, actual_content_type, "manifest MIME type must match the asset allowlist");
        assert_eq!(immutable, url.starts_with("/assets/"), "only fingerprinted assets are immutable");
        println!("cargo:rerun-if-changed={}", canonical_path.display());
        entries.push((url.to_string(), content_type.to_string(), immutable, canonical_path));
    }

    assert!(listed_urls.contains("/"), "manifest must include the HTML shell");
    let emitted_paths = files_below(dist);
    let expected_paths = listed_paths.into_iter().chain(["manifest.json".to_string()]).collect::<BTreeSet<_>>();
    assert_eq!(emitted_paths, expected_paths, "web/dist contains files outside the manifest");

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let mut source = String::from(
        "pub struct EmbeddedAsset { pub url: &'static str, pub content_type: &'static str, pub immutable: bool, pub body: &'static [u8] }\npub static ASSETS: &[EmbeddedAsset] = &[\n",
    );
    for (url, content_type, immutable, path) in entries {
        source.push_str(&format!(
            "EmbeddedAsset {{ url: {:?}, content_type: {:?}, immutable: {immutable}, body: include_bytes!({:?}) }},\n",
            url,
            content_type,
            path,
        ));
    }
    source.push_str("];\n");
    fs::write(out_dir.join("embedded_assets.rs"), source).expect("write embedded asset table");
    println!("cargo:rerun-if-changed=build.rs");
}

fn files_below(root: &Path) -> BTreeSet<String> {
    let mut files = BTreeSet::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).expect("read web/dist") {
            let entry = entry.expect("read web/dist entry");
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).expect("read web/dist metadata");
            assert!(!metadata.file_type().is_symlink(), "web/dist must not contain symlinks");
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                files.insert(path.strip_prefix(root).expect("path is inside web/dist").to_string_lossy().replace('\\', "/"));
            } else {
                panic!("web/dist contains a non-file asset");
            }
        }
    }
    files
}
