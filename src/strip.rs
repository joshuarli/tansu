/// Strip markdown syntax using pulldown-cmark, returning plain text for indexing.
use crate::frontmatter;
use pulldown_cmark::{Event, Parser, Tag, TagEnd};

pub fn strip_markdown(markdown: &str) -> String {
    let body = frontmatter::split_tags(markdown).body;
    let parser = Parser::new(body);
    let mut out = String::with_capacity(body.len());
    let mut in_code_block = false;

    for event in parser {
        match event {
            Event::Text(text) if !in_code_block => {
                if !out.is_empty() && !out.ends_with(' ') && !out.ends_with('\n') {
                    out.push(' ');
                }
                out.push_str(&text);
            }
            Event::Code(code) => {
                if !out.is_empty() && !out.ends_with(' ') && !out.ends_with('\n') {
                    out.push(' ');
                }
                out.push_str(&code);
            }
            Event::SoftBreak | Event::HardBreak => {
                out.push('\n');
            }
            Event::Start(Tag::CodeBlock(_)) => {
                in_code_block = true;
            }
            Event::End(TagEnd::CodeBlock) => {
                in_code_block = false;
            }
            Event::Start(Tag::Paragraph) if !out.is_empty() => {
                out.push('\n');
            }
            _ => {}
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_headings() {
        assert_eq!(strip_markdown("# Hello\n\nWorld"), "Hello\nWorld");
    }

    #[test]
    fn strips_emphasis() {
        let result = strip_markdown("**bold** and *italic*");
        assert!(result.contains("bold"));
        assert!(result.contains("italic"));
        assert!(!result.contains("*"));
    }

    #[test]
    fn strips_links() {
        let result = strip_markdown("[text](http://url)");
        assert!(result.contains("text"));
        assert!(!result.contains("http"));
    }

    #[test]
    fn preserves_inline_code() {
        let result = strip_markdown("Use `foo` here");
        assert!(result.contains("foo"));
        assert!(!result.contains("`"));
    }

    #[test]
    fn skips_code_blocks() {
        let md = "Before\n\n```\ncode here\n```\n\nAfter";
        let result = strip_markdown(md);
        assert!(!result.contains("code here"));
        assert!(result.contains("Before"));
        assert!(result.contains("After"));
    }

    #[test]
    fn strips_list_markers() {
        let md = "- one\n- two\n- three";
        let result = strip_markdown(md);
        assert!(result.contains("one"));
        assert!(result.contains("two"));
        assert!(!result.contains("-"));
    }

    #[test]
    fn empty_input() {
        assert_eq!(strip_markdown(""), "");
    }

    #[test]
    fn plain_text_unchanged() {
        assert_eq!(strip_markdown("just plain text"), "just plain text");
    }
}
