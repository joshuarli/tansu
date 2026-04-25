/// Single-pass extraction of headings and [[wiki-links]] from raw markdown.

pub struct ScanResult {
    pub title: String,
    pub headings: Vec<String>,
    pub links: Vec<String>,
}

pub fn scan(content: &str) -> ScanResult {
    let mut title = String::new();
    let mut headings = Vec::new();
    let mut links = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();

        // Headings: lines starting with # followed by space
        if let Some(rest) = trimmed.strip_prefix('#') {
            let (level, text) = count_heading(rest);
            if level > 0 && !text.is_empty() {
                if title.is_empty() && level == 1 {
                    title = text.to_string();
                }
                headings.push(text.to_string());
                extract_wiki_links(trimmed, &mut links);
                continue;
            }
        }

        extract_wiki_links(trimmed, &mut links);
    }

    ScanResult {
        title,
        headings,
        links,
    }
}

/// Returns (heading_level, text_after_hashes). Level 0 means not a heading continuation.
fn count_heading(after_first_hash: &str) -> (usize, &str) {
    let mut level = 1usize;
    let bytes = after_first_hash.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i] == b'#' {
        level += 1;
        i += 1;
    }
    // Must be followed by a space
    if i < bytes.len() && bytes[i] == b' ' {
        (level, after_first_hash[i + 1..].trim())
    } else {
        (0, "")
    }
}

fn extract_wiki_links(line: &str, links: &mut Vec<String>) {
    let mut rest = line;
    while let Some(pos) = rest.find("[[") {
        let after = &rest[pos + 2..];
        if let Some(end) = after.find("]]") {
            let target = &after[..end];
            // Skip image embeds (![[...)  — those start with !
            let is_image = pos > 0 && rest.as_bytes()[pos - 1] == b'!';
            if !is_image && !target.is_empty() {
                // Handle [[target|display]] syntax
                let link = target.split('|').next().unwrap_or(target).trim();
                if !link.is_empty() {
                    links.push(normalize_link(link));
                }
            }
            rest = &after[end + 2..];
        } else {
            break;
        }
    }
}

/// Normalize a wiki-link target: extract filename stem, lowercase, strip .md extension.
/// [[sub/My Note.md]] → "my note", [[UPPER]] → "upper"
pub fn normalize_link(link: &str) -> String {
    let link = link.trim();
    // Extract filename portion (after last /)
    let filename = link.rsplit('/').next().unwrap_or(link);
    let filename = filename.strip_suffix(".md").unwrap_or(filename);
    filename.to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_extracts_h1_title() {
        let r = scan("# My Title\n\nSome text");
        assert_eq!(r.title, "My Title");
    }

    #[test]
    fn scan_extracts_multiple_headings() {
        let r = scan("# Title\n## Section\n### Sub");
        assert_eq!(r.headings, vec!["Title", "Section", "Sub"]);
    }

    #[test]
    fn scan_no_title_without_h1() {
        let r = scan("## Not a title\n\nJust text");
        assert_eq!(r.title, "");
        assert_eq!(r.headings, vec!["Not a title"]);
    }

    #[test]
    fn scan_extracts_wiki_links() {
        let r = scan("See [[other note]] and [[sub/page]].");
        // [[sub/page]] extracts stem "page" for backlink matching
        assert_eq!(r.links, vec!["other note", "page"]);
    }

    #[test]
    fn scan_wiki_link_with_display_text() {
        let r = scan("See [[target|display text]].");
        assert_eq!(r.links, vec!["target"]);
    }

    #[test]
    fn scan_skips_image_embeds() {
        let r = scan("Text ![[image.webp]] and [[real link]].");
        assert_eq!(r.links, vec!["real link"]);
    }

    #[test]
    fn scan_normalizes_links() {
        let r = scan("[[My Note.md]] and [[UPPER]]");
        assert_eq!(r.links, vec!["my note", "upper"]);
    }

    #[test]
    fn scan_wiki_links_in_headings() {
        let r = scan("# Title with [[link]]");
        assert_eq!(r.links, vec!["link"]);
    }

    #[test]
    fn scan_multiple_links_per_line() {
        let r = scan("See [[a]], [[b]], and [[c]].");
        assert_eq!(r.links, vec!["a", "b", "c"]);
    }

    #[test]
    fn scan_unclosed_bracket_ignored() {
        let r = scan("Some [[unclosed bracket text");
        assert!(r.links.is_empty());
    }

    #[test]
    fn scan_empty_brackets_ignored() {
        let r = scan("Empty [[]] brackets");
        assert!(r.links.is_empty());
    }

    #[test]
    fn normalize_link_strips_path() {
        assert_eq!(normalize_link("sub/My Note"), "my note");
    }

    #[test]
    fn normalize_link_strips_path_and_extension() {
        assert_eq!(normalize_link("folder/deep/Note.md"), "note");
    }

    #[test]
    fn normalize_link_simple() {
        assert_eq!(normalize_link("Hello World"), "hello world");
    }

    #[test]
    fn normalize_link_trims_whitespace() {
        assert_eq!(normalize_link("  spaced  "), "spaced");
    }

    #[test]
    fn scan_subdirectory_link_extracts_stem() {
        let r = scan("See [[folder/my note]].");
        assert_eq!(r.links, vec!["my note"]);
    }
}
