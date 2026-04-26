use std::collections::BTreeSet;

pub struct Frontmatter<'a> {
    pub has_frontmatter: bool,
    pub tags: Vec<String>,
    pub body: &'a str,
}

pub fn split_tags(content: &str) -> Frontmatter<'_> {
    let Some((body, tags)) = split_tags_impl(content) else {
        return Frontmatter {
            has_frontmatter: false,
            tags: Vec::new(),
            body: content,
        };
    };
    Frontmatter {
        has_frontmatter: true,
        tags,
        body,
    }
}

pub fn build_tags(tags: &[String]) -> String {
    if tags.is_empty() {
        return String::new();
    }
    format!("---\ntags: [{}]\n---\n\n", tags.join(", "))
}

pub fn with_tags(body: &str, tags: &[String]) -> String {
    if tags.is_empty() {
        body.to_string()
    } else {
        format!("{}{}", build_tags(tags), body)
    }
}

fn split_tags_impl(content: &str) -> Option<(&str, Vec<String>)> {
    let (first_line, mut offset) = next_line(content, 0);
    if first_line.trim() != "---" {
        return None;
    }

    let mut tags = Vec::new();
    while offset < content.len() {
        let (line, next) = next_line(content, offset);
        if line.trim() == "---" {
            let mut body_start = next;
            if body_start < content.len() {
                let (maybe_blank, after_blank) = next_line(content, body_start);
                if maybe_blank.is_empty() {
                    body_start = after_blank;
                }
            }
            return Some((&content[body_start..], tags));
        }

        if let Some(parsed) = parse_tags_line(line) {
            tags = parsed;
        }
        offset = next;
    }

    None
}

fn parse_tags_line(line: &str) -> Option<Vec<String>> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix("tags:")?.trim();
    if rest.is_empty() {
        return Some(Vec::new());
    }
    let inner = rest
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(rest);
    Some(normalize_tags(
        inner
            .split(',')
            .map(|tag| tag.trim().trim_matches('"').trim_matches('\'')),
    ))
}

fn normalize_tags<'a>(tags: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut set = BTreeSet::new();
    for tag in tags {
        if let Some(normalized) = normalize_tag(tag) {
            set.insert(normalized);
        }
    }
    set.into_iter().collect()
}

fn normalize_tag(tag: &str) -> Option<String> {
    let normalized: String = tag
        .chars()
        .filter_map(|ch| {
            let lower = ch.to_ascii_lowercase();
            matches!(lower, 'a'..='z' | '0'..='9' | '_' | '-').then_some(lower)
        })
        .collect();
    (!normalized.is_empty()).then_some(normalized)
}

fn next_line(s: &str, start: usize) -> (&str, usize) {
    if start >= s.len() {
        return ("", s.len());
    }
    match s[start..].find('\n') {
        Some(rel) => {
            let end = start + rel;
            (s[start..end].trim_end_matches('\r'), end + 1)
        }
        None => (s[start..].trim_end_matches('\r'), s.len()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_tags_detects_inline_frontmatter_tags() {
        let src = "---\ntags: [alpha, beta]\n---\n\n# Title";
        let fm = split_tags(src);
        assert!(fm.has_frontmatter);
        assert_eq!(fm.tags, vec!["alpha", "beta"]);
        assert_eq!(fm.body, "# Title");
    }

    #[test]
    fn split_tags_returns_input_when_no_frontmatter() {
        let src = "# Title\n\nBody";
        let fm = split_tags(src);
        assert!(!fm.has_frontmatter);
        assert!(fm.tags.is_empty());
        assert_eq!(fm.body, src);
    }

    #[test]
    fn build_tags_wraps_body() {
        let src = with_tags("# Title", &["alpha".to_string(), "beta".to_string()]);
        assert_eq!(src, "---\ntags: [alpha, beta]\n---\n\n# Title");
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
}
