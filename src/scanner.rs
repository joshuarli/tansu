/// Single-pass extraction of headings and [[wiki-links]] from raw markdown.
use crate::frontmatter;
use std::path::Path;

pub struct ScanResult {
    pub title: String,
    pub headings: Vec<String>,
    pub links: Vec<String>,
}

pub fn scan(content: &str) -> ScanResult {
    let body = frontmatter::split_tags(content).body;
    let title = leading_heading_line(body)
        .map(|heading| heading.text.to_string())
        .unwrap_or_default();
    let mut headings = Vec::new();
    let mut links = Vec::new();

    for line in body.lines() {
        let trimmed = line.trim();

        if let Some((level, text)) = parse_heading(trimmed)
            && level > 0
            && !text.is_empty()
        {
            headings.push(text.to_string());
            extract_wiki_links(trimmed, &mut links);
            continue;
        }

        extract_wiki_links(trimmed, &mut links);
    }

    ScanResult {
        title,
        headings,
        links,
    }
}

pub fn title_from_path(rel_path: &str) -> String {
    Path::new(rel_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(rel_path)
        .to_string()
}

pub fn official_title(rel_path: &str, content: &str) -> String {
    let title = scan(content).title;
    if title.is_empty() {
        title_from_path(rel_path)
    } else {
        title
    }
}

pub fn sanitize_filename_stem(title: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in title.trim().chars() {
        let invalid = matches!(
            ch,
            '\0'..='\u{1f}' | '\u{7f}' | '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
        );
        if invalid {
            if !last_dash {
                out.push('-');
                last_dash = true;
            }
        } else {
            out.push(ch);
            last_dash = ch == '-';
        }
    }

    let trimmed = out.trim_matches(|ch: char| ch == '.' || ch == '-' || ch.is_whitespace());
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn upsert_title_h1(content: &str, title: &str) -> String {
    let fm = frontmatter::split_tags(content);
    let body_start = content.len() - fm.body.len();
    let prefix = &content[..body_start];
    let body = fm.body;
    let line = format!("# {}\n", title.trim());

    if let Some(first) = leading_heading_line(body)
        && first.level == 1
    {
        let mut out = String::with_capacity(content.len() + line.len());
        out.push_str(prefix);
        out.push_str(&body[..first.start]);
        out.push_str(line.trim_end_matches('\n'));
        out.push_str(&body[first.end..]);
        return out;
    }

    let mut out = String::with_capacity(content.len() + line.len() + 1);
    out.push_str(prefix);
    out.push_str(&line);
    out.push('\n');
    if body.is_empty() {
        return out;
    }
    out.push_str(body);
    out
}

struct HeadingLine {
    start: usize,
    end: usize,
    level: usize,
    text: String,
}

fn leading_heading_line(body: &str) -> Option<HeadingLine> {
    let start = body
        .char_indices()
        .find_map(|(idx, ch)| (!ch.is_whitespace()).then_some(idx))?;
    let line_end = body[start..]
        .find('\n')
        .map(|idx| start + idx)
        .unwrap_or(body.len());
    let line = body[start..line_end].trim_end_matches('\r');
    let (level, text) = parse_heading(line)?;
    if text.is_empty() {
        return None;
    }
    Some(HeadingLine {
        start,
        end: start + line.len(),
        level,
        text: text.to_string(),
    })
}

fn parse_heading(line: &str) -> Option<(usize, &str)> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix('#')?;
    let mut level = 1usize;
    let bytes = rest.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i] == b'#' {
        level += 1;
        i += 1;
    }
    if level > 6 || i >= bytes.len() || bytes[i] != b' ' {
        return None;
    }
    Some((level, strip_closing_hashes(rest[i + 1..].trim())))
}

fn strip_closing_hashes(text: &str) -> &str {
    let trimmed = text.trim_end();
    let without_hashes = trimmed.trim_end_matches('#');
    if without_hashes.len() != trimmed.len()
        && without_hashes
            .chars()
            .last()
            .is_some_and(char::is_whitespace)
    {
        without_hashes.trim_end()
    } else {
        text
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
    fn scan_ignores_non_leading_heading_for_title() {
        let r = scan("intro\n\n## First Heading\n\n# Later");
        assert_eq!(r.title, "");
        assert_eq!(r.headings, vec!["First Heading", "Later"]);
    }

    #[test]
    fn scan_extracts_leading_heading_after_whitespace() {
        let r = scan("\n\t  ## First Heading\n\nBody");
        assert_eq!(r.title, "First Heading");
    }

    #[test]
    fn scan_extracts_leading_heading_after_frontmatter() {
        let r = scan("---\ntags: [x]\n---\n\n  ### First Heading\n\nBody");
        assert_eq!(r.title, "First Heading");
    }

    #[test]
    fn scan_extracts_multiple_headings() {
        let r = scan("# Title\n## Section\n### Sub");
        assert_eq!(r.headings, vec!["Title", "Section", "Sub"]);
    }

    #[test]
    fn scan_no_title_without_h1() {
        let r = scan("## Not a title\n\nJust text");
        assert_eq!(r.title, "Not a title");
        assert_eq!(r.headings, vec!["Not a title"]);
    }

    #[test]
    fn official_title_falls_back_to_path_stem() {
        assert_eq!(official_title("dir/my-note.md", "plain text"), "my-note");
    }

    #[test]
    fn sanitize_filename_replaces_unsafe_characters() {
        assert_eq!(sanitize_filename_stem("  A/B:C*D?  "), "A-B-C-D");
        assert_eq!(sanitize_filename_stem("..."), "untitled");
    }

    #[test]
    fn upsert_title_h1_inserts_after_frontmatter() {
        let src = "---\ntags: [x]\n---\n\nbody";
        assert_eq!(
            upsert_title_h1(src, "New Note"),
            "---\ntags: [x]\n---\n\n# New Note\n\nbody"
        );
    }

    #[test]
    fn upsert_title_h1_updates_first_h1() {
        assert_eq!(upsert_title_h1("# Old\n\nBody", "New"), "# New\n\nBody");
    }

    #[test]
    fn upsert_title_h1_does_not_update_later_h1() {
        assert_eq!(
            upsert_title_h1("Intro\n\n# Old", "New"),
            "# New\n\nIntro\n\n# Old"
        );
    }

    #[test]
    fn upsert_title_h1_inserts_before_non_h1_first_heading() {
        assert_eq!(
            upsert_title_h1("## Section", "Title"),
            "# Title\n\n## Section"
        );
    }

    #[test]
    fn upsert_title_h1_creates_body_separator_for_empty_note() {
        assert_eq!(upsert_title_h1("", "Title"), "# Title\n\n");
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
