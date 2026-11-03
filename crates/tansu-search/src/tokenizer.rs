use tantivy::tokenizer::{Token, TokenFilter, TokenStream, Tokenizer};
use unicode_normalization::UnicodeNormalization;

#[derive(Clone)]
pub struct FerrisearchTokenizer {
    separator_re: regex::Regex,
}

impl FerrisearchTokenizer {
    pub fn new() -> Self {
        Self {
            separator_re: regex::Regex::new(r"[\p{P}\p{Z}\p{Cc}\p{S}]+")
                .expect("Invalid separator regex"),
        }
    }
}

impl Default for FerrisearchTokenizer {
    fn default() -> Self {
        Self::new()
    }
}

impl Tokenizer for FerrisearchTokenizer {
    type TokenStream<'a> = FerrisearchTokenStream;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> Self::TokenStream<'a> {
        let mut tokens = Vec::new();
        let mut position = 0;

        if text.is_ascii() {
            let mut segment_start = 0;
            for (byte_idx, byte) in text.bytes().enumerate() {
                if !byte.is_ascii_alphanumeric() {
                    if segment_start < byte_idx {
                        emit_tokens(
                            &mut tokens,
                            &text[segment_start..byte_idx],
                            segment_start,
                            &mut position,
                        );
                    }
                    segment_start = byte_idx + 1;
                }
            }
            if segment_start < text.len() {
                emit_tokens(&mut tokens, &text[segment_start..], segment_start, &mut position);
            }
            return FerrisearchTokenStream {
                tokens,
                index: usize::MAX,
            };
        }

        let mut last_end = 0;

        for mat in self.separator_re.find_iter(text) {
            let segment = &text[last_end..mat.start()];
            if !segment.is_empty() {
                emit_tokens(&mut tokens, segment, last_end, &mut position);
            }
            last_end = mat.end();
        }

        let tail = &text[last_end..];
        if !tail.is_empty() {
            emit_tokens(&mut tokens, tail, last_end, &mut position);
        }

        FerrisearchTokenStream {
            tokens,
            index: usize::MAX,
        }
    }
}

fn emit_tokens(tokens: &mut Vec<Token>, segment: &str, offset_from: usize, position: &mut usize) {
    let offset_to = offset_from + segment.len();
    let pos = *position;

    tokens.push(Token {
        offset_from,
        offset_to,
        position: pos,
        text: lowercase(segment),
        ..Default::default()
    });

    let mut part_start = 0;
    let mut prev_lower = false;
    let mut has_boundary = false;
    for (byte_idx, ch) in segment.char_indices() {
        if prev_lower && ch.is_uppercase() && byte_idx > part_start {
            tokens.push(Token {
                offset_from,
                offset_to,
                position: pos,
                text: lowercase(&segment[part_start..byte_idx]),
                ..Default::default()
            });
            part_start = byte_idx;
            has_boundary = true;
        }
        prev_lower = ch.is_lowercase();
    }
    if has_boundary {
        tokens.push(Token {
            offset_from,
            offset_to,
            position: pos,
            text: lowercase(&segment[part_start..]),
            ..Default::default()
        });
    }


    *position += 1;
}

#[inline]
fn lowercase(text: &str) -> String {
    if text.is_ascii() {
        text.to_ascii_lowercase()
    } else {
        text.to_lowercase()
    }
}

pub struct FerrisearchTokenStream {
    tokens: Vec<Token>,
    index: usize,
}

impl TokenStream for FerrisearchTokenStream {
    fn advance(&mut self) -> bool {
        self.index = self.index.wrapping_add(1);
        self.index < self.tokens.len()
    }

    fn token(&self) -> &Token {
        &self.tokens[self.index]
    }

    fn token_mut(&mut self) -> &mut Token {
        &mut self.tokens[self.index]
    }
}


#[derive(Clone)]
pub struct DiacriticFilter;

impl TokenFilter for DiacriticFilter {
    type Tokenizer<T: Tokenizer> = DiacriticFilterWrapper<T>;

    fn transform<T: Tokenizer>(self, tokenizer: T) -> Self::Tokenizer<T> {
        DiacriticFilterWrapper { inner: tokenizer }
    }
}

#[derive(Clone)]
pub struct DiacriticFilterWrapper<T> {
    inner: T,
}

impl<T: Tokenizer> Tokenizer for DiacriticFilterWrapper<T> {
    type TokenStream<'a> = DiacriticFilterStream<T::TokenStream<'a>>;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> Self::TokenStream<'a> {
        DiacriticFilterStream {
            inner: self.inner.token_stream(text),
        }
    }
}

pub struct DiacriticFilterStream<T> {
    inner: T,
}

impl<T: TokenStream> TokenStream for DiacriticFilterStream<T> {
    fn advance(&mut self) -> bool {
        if !self.inner.advance() {
            return false;
        }
        let stripped: String = self
            .inner
            .token()
            .text
            .nfd()
            .filter(|c| !unicode_normalization::char::is_combining_mark(*c))
            .nfc()
            .collect();
        self.inner.token_mut().text = stripped;
        true
    }

    fn token(&self) -> &Token {
        self.inner.token()
    }

    fn token_mut(&mut self) -> &mut Token {
        self.inner.token_mut()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokenize(text: &str) -> Vec<String> {
        let mut t = FerrisearchTokenizer::new();
        let mut stream = t.token_stream(text);
        let mut out = Vec::new();
        while stream.advance() {
            out.push(stream.token().text.clone());
        }
        out
    }

    fn tokenize_with_positions(text: &str) -> Vec<(String, usize, usize, usize)> {
        let mut t = FerrisearchTokenizer::new();
        let mut stream = t.token_stream(text);
        let mut out = Vec::new();
        while stream.advance() {
            let token = stream.token();
            out.push((
                token.text.clone(),
                token.position,
                token.offset_from,
                token.offset_to,
            ));
        }
        out
    }

    #[test]
    fn segments_text_into_lowercase_terms() {
        let cases: &[(&str, &[&str])] = &[
            ("hello world", &["hello", "world"]),
            ("foo.bar,baz", &["foo", "bar", "baz"]),
            ("fooBarBaz", &["foobarbaz", "foo", "bar", "baz"]),
            ("myVariableName", &["myvariablename", "my", "variable", "name"]),
            ("foo-bar-baz", &["foo", "bar", "baz"]),
            ("foo\u{2013}bar", &["foo", "bar"]),
            ("", &[]),
            ("HELLO World", &["hello", "world"]),
            ("foo...bar!!!baz", &["foo", "bar", "baz"]),
            ("  ...hello world...  ", &["hello", "world"]),
            ("...   !!!", &[]),
            ("hello 世界", &["hello", "世界"]),
            ("foo\tbar\nbaz", &["foo", "bar", "baz"]),
            ("foo|bar", &["foo", "bar"]),
        ];
        for (input, expected) in cases {
            let expected: Vec<String> = expected.iter().map(|term| term.to_string()).collect();
            assert_eq!(tokenize(input), expected, "input: {input:?}");
        }
    }

    #[test]
    fn shares_parent_position_and_reports_byte_offsets() {
        assert_eq!(
            tokenize_with_positions("fooBar baz"),
            vec![
                ("foobar".to_string(), 0, 0, 6),
                ("foo".to_string(), 0, 0, 6),
                ("bar".to_string(), 0, 0, 6),
                ("baz".to_string(), 1, 7, 10),
            ]
        );
        assert_eq!(
            tokenize_with_positions("hello world"),
            vec![
                ("hello".to_string(), 0, 0, 5),
                ("world".to_string(), 1, 6, 11),
            ]
        );
    }

    #[test]
    fn strips_diacritics_through_the_filter() {
        use tantivy::tokenizer::TokenFilter;
        let mut t = DiacriticFilter.transform(FerrisearchTokenizer::new());
        let mut stream = t.token_stream("café résumé");
        let mut out = Vec::new();
        while stream.advance() {
            out.push(stream.token().text.clone());
        }
        assert_eq!(out, vec!["cafe".to_string(), "resume".to_string()]);
    }

}
