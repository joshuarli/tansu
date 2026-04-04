/// Single-pass extraction of headings, #tags, and [[wiki-links]] from raw markdown.

pub struct ScanResult {
    pub title: String,
    pub headings: Vec<String>,
    pub tags: Vec<String>,
    pub links: Vec<String>,
}

pub fn scan(content: &str) -> ScanResult {
    let mut title = String::new();
    let mut headings = Vec::new();
    let mut tags = Vec::new();
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
            }
            // Don't scan heading lines for tags (# is ambiguous)
            // But still scan for wiki-links
            extract_wiki_links(trimmed, &mut links);
            continue;
        }

        // Scan line for tags and wiki-links
        extract_tags(trimmed, &mut tags);
        extract_wiki_links(trimmed, &mut links);
    }

    ScanResult {
        title,
        headings,
        tags,
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

fn extract_tags(line: &str, tags: &mut Vec<String>) {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'#' {
            // Must be preceded by whitespace or start of line
            if i > 0 && !bytes[i - 1].is_ascii_whitespace() {
                i += 1;
                continue;
            }
            // Collect tag characters: alphanumeric, -, _
            let start = i + 1;
            let mut j = start;
            while j < bytes.len()
                && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'-' || bytes[j] == b'_')
            {
                j += 1;
            }
            if j > start {
                tags.push(line[start..j].to_string());
            }
            i = j;
        } else {
            i += 1;
        }
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

/// Normalize a wiki-link target: lowercase, strip .md extension.
pub fn normalize_link(link: &str) -> String {
    let link = link.trim();
    let link = link.strip_suffix(".md").unwrap_or(link);
    link.to_lowercase()
}
