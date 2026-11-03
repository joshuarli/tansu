pub const PREVIEW_MAX_CHARS: usize = 280;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_strips_frontmatter_and_truncates() {
        assert_eq!(preview("---\ntags: [x]\n---\n# T\n\nbody  text\n"), "# T body text");
        assert_eq!(preview("---\nunclosed\n"), "--- unclosed");
        assert_eq!(preview(&"ab ".repeat(300)).chars().count(), PREVIEW_MAX_CHARS);
    }
}
