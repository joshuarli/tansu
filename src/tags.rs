use crate::paths::title_from_path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedMarkdown {
    pub tags: Vec<String>,
    pub title: String,
    pub frontmatter_supported: bool,
}

pub fn parse_markdown(path: &str, content: &str) -> ParsedMarkdown {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let (tags, supported) = parse_tags_frontmatter(content);
    ParsedMarkdown {
        tags,
        title: extract_title(path, content),
        frontmatter_supported: supported,
    }
}

fn parse_tags_frontmatter(content: &str) -> (Vec<String>, bool) {
    let mut lines = content.lines();
    if lines.next() != Some("---") {
        return (Vec::new(), true);
    }
    let mut tags = Vec::new();
    let mut has_tags = false;
    let mut tags_only = true;
    let mut in_tags_list = false;
    for line in lines {
        if line == "---" {
            return (tags, tags_only);
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('#') {
            tags_only = false;
            continue;
        }
        if !line.starts_with(' ') && !line.starts_with('\t') {
            in_tags_list = false;
            let Some((key, rest)) = line.split_once(':') else {
                return (Vec::new(), false);
            };
            if key.trim() != "tags" {
                tags_only = false;
                continue;
            }
            if has_tags {
                return (Vec::new(), false);
            }
            has_tags = true;
            let rest = rest.trim();
            if rest.is_empty() {
                in_tags_list = true;
                continue;
            }
            if rest.starts_with('[') && rest.ends_with(']') {
                tags.extend(
                    rest.trim_matches(['[', ']'])
                        .split(',')
                        .map(|tag| tag.trim().trim_matches('"').trim_matches('\''))
                        .filter(|tag| !tag.is_empty())
                        .map(ToOwned::to_owned),
                );
            } else if rest.starts_with('[') || rest.ends_with(']') {
                return (Vec::new(), false);
            } else if !rest.is_empty() {
                tags.extend(
                    rest.split(',')
                        .map(str::trim)
                        .filter(|tag| !tag.is_empty())
                        .map(ToOwned::to_owned),
                );
            }
            continue;
        }
        if in_tags_list && let Some(tag) = trimmed.strip_prefix('-') {
            let tag = tag.trim().trim_matches('"').trim_matches('\'');
            if !tag.is_empty() {
                tags.push(tag.to_string());
            }
            continue;
        }
        tags_only = false;
        if in_tags_list && !trimmed.starts_with('#') {
            return (Vec::new(), false);
        }
    }
    (Vec::new(), false)
}

pub fn extract_title(path: &str, content: &str) -> String {
    for line in content.lines() {
        if let Some(title) = line.trim_start().strip_prefix("# ") {
            let title = title.trim();
            if !title.is_empty() {
                return title.to_string();
            }
        }
    }
    title_from_path(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tags_only_frontmatter() {
        let parsed = parse_markdown("x.md", "---\ntags: [one, two]\n---\n# Title\n");
        assert_eq!(parsed.tags, vec!["one", "two"]);
        assert_eq!(parsed.title, "Title");
        assert!(parsed.frontmatter_supported);
    }

    #[test]
    fn parses_display_metadata_after_a_source_bom_without_removing_it_from_source() {
        let source = "\u{feff}---\ntags: [rust]\n---\n# Heading\n";
        let parsed = parse_markdown("fallback.md", source);

        assert_eq!(parsed.tags, vec!["rust"]);
        assert_eq!(parsed.title, "Heading");
        assert!(source.starts_with('\u{feff}'));
    }

    #[test]
    fn leaves_non_tag_frontmatter_as_content() {
        let parsed = parse_markdown("x.md", "---\nauthor: Jane\n---\n# Title\n");
        assert!(parsed.tags.is_empty());
        assert!(!parsed.frontmatter_supported);
        assert_eq!(parsed.title, "Title");
    }

    #[test]
    fn parses_tag_scalars_lists_quotes_and_fallback_titles() {
        assert_eq!(
            parse_markdown("daily note.md", "---\ntags: alpha, beta\n---\nbody\n").tags,
            vec!["alpha", "beta"]
        );
        assert_eq!(
            parse_markdown("x.md", "---\ntags:\n  - 'alpha'\n  - \"beta\"\n---\n").tags,
            vec!["alpha", "beta"]
        );
        assert_eq!(parse_markdown("daily note.md", "body").title, "daily note");
        assert_eq!(extract_title("x.md", "#   \n## ignored\n"), "x");
    }

    #[test]
    fn rejects_unclosed_or_mixed_frontmatter() {
        let unclosed = parse_markdown("x.md", "---\ntags: [alpha]\n# Body\n");
        assert!(!unclosed.frontmatter_supported);
        assert!(unclosed.tags.is_empty());

        let mixed = parse_markdown("x.md", "---\ntags:\n  - alpha\nauthor: Jane\n---\n");
        assert!(!mixed.frontmatter_supported);
        assert_eq!(mixed.tags, vec!["alpha"]);
    }
}
