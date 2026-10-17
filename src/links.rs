use crate::api_types::NoteMeta;

pub const MENTION_MAX_CHARS: usize = 200;
pub const PREVIEW_MAX_CHARS: usize = 280;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawLink {
    pub target: String,
    pub mention: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution<'a> {
    Resolved(&'a NoteMeta),
    Missing,
    Ambiguous,
    Invalid,
}

pub fn strip_frontmatter(content: &str) -> &str {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut offset = 0;
    let mut lines = content.split_inclusive('\n');
    match lines.next() {
        Some(first) if first.trim_end_matches(['\n', '\r']) == "---" => offset += first.len(),
        _ => return content,
    }
    for line in lines {
        offset += line.len();
        if line.trim_end_matches(['\n', '\r']) == "---" {
            return &content[offset..];
        }
    }
    content
}

pub fn preview(content: &str) -> String {
    let mut out = String::new();
    let mut count = 0;
    for word in strip_frontmatter(content).split_whitespace() {
        if count > 0 {
            out.push(' ');
            count += 1;
        }
        for ch in word.chars() {
            if count == PREVIEW_MAX_CHARS {
                return out;
            }
            out.push(ch);
            count += 1;
        }
    }
    out
}

pub fn extract_links(content: &str) -> Vec<RawLink> {
    let mut links = Vec::new();
    let mut in_fence = false;
    for line in strip_frontmatter(content).lines() {
        if is_fence(line) {
            in_fence = !in_fence;
            continue;
        }
        if !in_fence {
            scan_line(line, &mut links);
        }
    }
    links
}

pub fn resolve<'a>(target: &str, source_path: &str, notes: &'a [NoteMeta]) -> Resolution<'a> {
    let Some(requested) = normalize(target.trim()) else {
        return Resolution::Invalid;
    };
    if requested.is_empty() {
        return Resolution::Invalid;
    }
    let matches: Vec<&NoteMeta> = if requested.starts_with('/')
        || requested.starts_with("./")
        || requested.starts_with("../")
    {
        let Some(path) = explicit_path(&requested, source_path) else {
            return Resolution::Invalid;
        };
        notes
            .iter()
            .filter(|note| normalize(&note.path).is_some_and(|p| p.to_lowercase() == path))
            .collect()
    } else if requested.contains('/') {
        return Resolution::Invalid;
    } else {
        let wanted = requested.to_lowercase();
        notes
            .iter()
            .filter(|note| basename(&note.path).to_lowercase() == wanted)
            .collect()
    };
    match matches.as_slice() {
        [] => Resolution::Missing,
        [note] => Resolution::Resolved(note),
        _ => Resolution::Ambiguous,
    }
}

fn explicit_path(requested: &str, source_path: &str) -> Option<String> {
    let root = requested.starts_with('/');
    let mut path: Vec<&str> = Vec::new();
    let source = normalize(source_path).unwrap_or_default();
    if !root {
        path.extend(source.split('/'));
        path.pop();
    }
    let relative = if root { &requested[1..] } else { requested };
    for segment in relative.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                path.pop()?;
            }
            segment => path.push(segment),
        }
    }
    Some(path.join("/").to_lowercase())
}

fn basename(path: &str) -> String {
    let normalized = normalize(path).unwrap_or_default();
    normalized.rsplit('/').next().unwrap_or("").to_string()
}

fn normalize(path: &str) -> Option<String> {
    let mut normalized = path.replace('\\', "/");
    if normalized.len() >= 3 && normalized.as_bytes()[normalized.len() - 3..].eq_ignore_ascii_case(b".md") {
        normalized.truncate(normalized.len() - 3);
    }
    (!normalized.contains('\0')).then_some(normalized)
}

fn is_fence(line: &str) -> bool {
    let trimmed = line.trim_start_matches(' ');
    line.len() - trimmed.len() <= 3 && (trimmed.starts_with("```") || trimmed.starts_with("~~~"))
}

fn scan_line(line: &str, links: &mut Vec<RawLink>) {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let image = i > 0 && chars[i - 1] == '!';
        match chars[i] {
            '`' => match chars[i + 1..].iter().position(|c| *c == '`') {
                Some(offset) => i += offset + 2,
                None => i += 1,
            },
            '[' if chars.get(i + 1) == Some(&'[') => match find_pair(&chars, i + 2, ']', ']') {
                Some(end) => {
                    if !image {
                        let inner: String = chars[i + 2..end].iter().collect();
                        let target = inner.split('|').next().unwrap_or("").to_string();
                        links.push(RawLink { target, mention: mention_window(&chars, i) });
                    }
                    i = end + 2;
                }
                None => i += 1,
            },
            '[' => match markdown_destination_end(&chars, i + 1) {
                Some((start, end)) => {
                    if !image {
                        let destination: String = chars[start..end].iter().collect();
                        if let Some(target) = markdown_target(&destination) {
                            links.push(RawLink { target, mention: mention_window(&chars, i) });
                        }
                    }
                    i = end + 1;
                }
                None => i += 1,
            },
            _ => i += 1,
        }
    }
}

fn find_pair(chars: &[char], from: usize, first: char, second: char) -> Option<usize> {
    (from..chars.len().saturating_sub(1)).find(|&j| chars[j] == first && chars[j + 1] == second)
}

fn markdown_destination_end(chars: &[char], from: usize) -> Option<(usize, usize)> {
    let close = chars[from..].iter().position(|c| *c == ']')? + from;
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let end = chars[close + 2..].iter().position(|c| *c == ')')? + close + 2;
    Some((close + 2, end))
}

fn markdown_target(destination: &str) -> Option<String> {
    let destination = destination.trim();
    let destination = match destination.strip_prefix('<') {
        Some(rest) => rest.split('>').next()?,
        None => destination.split_whitespace().next()?,
    };
    let lowered = destination.to_ascii_lowercase();
    if destination.is_empty()
        || destination.starts_with('#')
        || destination.contains("://")
        || lowered.starts_with("mailto:")
        || lowered.starts_with("data:")
    {
        return None;
    }
    let path = destination.split(['#', '?']).next()?;
    let decoded = crate::api::percent_decode_path(path)?;
    if !decoded.to_ascii_lowercase().ends_with(".md") {
        return None;
    }
    if decoded.starts_with('/') || decoded.starts_with("./") || decoded.starts_with("../") {
        Some(decoded)
    } else {
        Some(format!("./{decoded}"))
    }
}

fn mention_window(chars: &[char], link_start: usize) -> String {
    let start = if chars.len() > MENTION_MAX_CHARS {
        link_start
            .saturating_sub(MENTION_MAX_CHARS / 3)
            .min(chars.len() - MENTION_MAX_CHARS)
    } else {
        0
    };
    let end = (start + MENTION_MAX_CHARS).min(chars.len());
    chars[start..end].iter().collect::<String>().trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: &str, path: &str) -> NoteMeta {
        NoteMeta {
            note_id: id.to_string(),
            path: path.to_string(),
            title: id.to_string(),
            tags: Vec::new(),
            seq: 1,
            content_hash: String::new(),
            updated_at_ms: 0,
        }
    }

    fn resolved_id(resolution: Resolution<'_>) -> Option<&str> {
        match resolution {
            Resolution::Resolved(note) => Some(note.note_id.as_str()),
            _ => None,
        }
    }

    #[test]
    fn root_relative_and_basename_targets_resolve_like_the_editor() {
        let notes = vec![note("a", "A.md"), note("b", "dir/B.md"), note("c", "dir/sub/C.md")];
        assert_eq!(resolved_id(resolve("/dir/B", "A.md", &notes)), Some("b"));
        assert_eq!(resolved_id(resolve("/DIR/b.md", "A.md", &notes)), Some("b"));
        assert_eq!(resolved_id(resolve("./sub/C", "dir/B.md", &notes)), Some("c"));
        assert_eq!(resolved_id(resolve("../A", "dir/B.md", &notes)), Some("a"));
        assert_eq!(resolved_id(resolve("C", "A.md", &notes)), Some("c"));
        assert_eq!(resolve("../../A", "dir/B.md", &notes), Resolution::Invalid);
        assert_eq!(resolve("dir/B", "A.md", &notes), Resolution::Invalid);
        assert_eq!(resolve("  ", "A.md", &notes), Resolution::Invalid);
        assert_eq!(resolve("Nope", "A.md", &notes), Resolution::Missing);
    }

    #[test]
    fn ambiguous_basename_is_unresolved_but_explicit_path_resolves() {
        let notes = vec![note("a", "x/Same.md"), note("b", "y/Same.md")];
        assert_eq!(resolve("Same", "z.md", &notes), Resolution::Ambiguous);
        assert_eq!(resolved_id(resolve("/y/Same", "z.md", &notes)), Some("b"));
    }

    #[test]
    fn extracts_wiki_and_markdown_note_links_with_line_context() {
        let content = "---\ntags: [x]\n---\n# T\nSee [[Alpha|the alpha]] and [b](sub/B.md#h) too.\n![[img.png]] ![i](x.md)\n`[[code]]` [web](https://x.test/a.md) [t](t.txt)\n```\n[[fenced]]\n```\n";
        let links = extract_links(content);
        assert_eq!(
            links.iter().map(|l| l.target.as_str()).collect::<Vec<_>>(),
            vec!["Alpha", "./sub/B.md"]
        );
        assert_eq!(links[0].mention, "See [[Alpha|the alpha]] and [b](sub/B.md#h) too.");
    }

    #[test]
    fn long_lines_are_windowed_around_the_link() {
        let line = format!("{} [[Alpha]] {}", "x".repeat(500), "y".repeat(500));
        let links = extract_links(&line);
        assert!(links[0].mention.chars().count() <= MENTION_MAX_CHARS);
        assert!(links[0].mention.contains("[[Alpha]]"));
    }

    #[test]
    fn preview_strips_frontmatter_and_truncates() {
        assert_eq!(preview("---\ntags: [x]\n---\n# T\n\nbody  text\n"), "# T body text");
        assert_eq!(preview("---\nunclosed\n"), "--- unclosed");
        assert_eq!(preview(&"ab ".repeat(300)).chars().count(), PREVIEW_MAX_CHARS);
    }
}
