/// Strip markdown syntax using pulldown-cmark, returning plain text for indexing.

use pulldown_cmark::{Event, Parser, Tag, TagEnd};

pub fn strip_markdown(markdown: &str) -> String {
    let parser = Parser::new(markdown);
    let mut out = String::with_capacity(markdown.len());
    let mut in_code_block = false;

    for event in parser {
        match event {
            Event::Text(text) => {
                if !in_code_block {
                    if !out.is_empty() && !out.ends_with(' ') && !out.ends_with('\n') {
                        out.push(' ');
                    }
                    out.push_str(&text);
                }
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
            Event::Start(Tag::Paragraph) => {
                if !out.is_empty() {
                    out.push('\n');
                }
            }
            _ => {}
        }
    }

    out
}
