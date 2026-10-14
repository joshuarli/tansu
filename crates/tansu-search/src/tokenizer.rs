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

    if segment.is_ascii() {
        let mut part_start = 0;
        let mut prev_lower = false;
        let mut has_boundary = false;
        for (byte_idx, byte) in segment.bytes().enumerate() {
            if prev_lower && byte.is_ascii_uppercase() && byte_idx > part_start {
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
            prev_lower = byte.is_ascii_lowercase();
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
    } else {
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

#[cfg(test)]
fn split_camel_case(text: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut prev_lower = false;

    for ch in text.chars() {
        if prev_lower && ch.is_uppercase() && !current.is_empty() {
            parts.push(std::mem::take(&mut current));
        }
        prev_lower = ch.is_lowercase();
        current.push(ch);
    }

    if !current.is_empty() {
        parts.push(current);
    }

    if parts.len() <= 1 { Vec::new() } else { parts }
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

    #[test]
    fn basic_tokenization() {
        let t = tokenize("hello world");
        assert!(t.contains(&"hello".into()));
        assert!(t.contains(&"world".into()));
    }

    #[test]
    fn punctuation_split() {
        let t = tokenize("foo.bar,baz");
        assert!(t.contains(&"foo".into()));
        assert!(t.contains(&"bar".into()));
        assert!(t.contains(&"baz".into()));
    }

    #[test]
    fn camel_case_split() {
        let t = tokenize("fooBarBaz");
        assert!(t.contains(&"foobarbaz".into()));
        assert!(t.contains(&"foo".into()));
        assert!(t.contains(&"bar".into()));
        assert!(t.contains(&"baz".into()));
    }

    #[test]
    fn hyphen_split() {
        let t = tokenize("foo-bar-baz");
        assert!(t.contains(&"foo".into()));
        assert!(t.contains(&"bar".into()));
        assert!(t.contains(&"baz".into()));
    }

    #[test]
    fn no_camel_case_for_all_lower() {
        assert!(split_camel_case("lowercase").is_empty());
    }

    #[test]
    fn unicode_separator() {
        let t = tokenize("foo\u{2013}bar");
        assert!(t.contains(&"foo".into()));
        assert!(t.contains(&"bar".into()));
    }

    #[test]
    fn empty_input() {
        assert!(tokenize("").is_empty());
    }

    #[test]
    fn camel_case_function() {
        assert_eq!(
            split_camel_case("fooBarBAZLorem"),
            ["foo", "Bar", "BAZLorem"]
        );
    }

    #[test]
    fn lowercasing() {
        let t = tokenize("HELLO World");
        assert!(t.contains(&"hello".into()));
        assert!(t.contains(&"world".into()));
    }

    #[test]
    fn consecutive_separators() {
        let t = tokenize("foo...bar!!!baz");
        assert!(t.contains(&"foo".into()));
        assert!(t.contains(&"bar".into()));
        assert!(t.contains(&"baz".into()));
    }

    #[test]
    fn leading_trailing_separators() {
        let t = tokenize("  ...hello world...  ");
        assert!(t.contains(&"hello".into()));
        assert!(t.contains(&"world".into()));
        assert!(!t.contains(&"".into()));
    }

    #[test]
    fn only_separators() {
        assert!(tokenize("...   !!!").is_empty());
    }

    #[test]
    fn camel_case_single_boundary() {
        assert_eq!(split_camel_case("fooBar"), ["foo", "Bar"]);
    }

    #[test]
    fn camel_case_all_upper() {
        assert!(split_camel_case("ALLCAPS").is_empty());
    }

    #[test]
    fn camel_case_single_char() {
        assert_eq!(split_camel_case("aB"), ["a", "B"]);
    }

    #[test]
    fn unicode_tokenization() {
        let t = tokenize("hello 世界");
        assert!(t.contains(&"hello".into()));
        assert!(t.contains(&"世界".into()));
    }

    #[test]
    fn tab_and_newline() {
        let t = tokenize("foo\tbar\nbaz");
        assert!(t.contains(&"foo".into()));
        assert!(t.contains(&"bar".into()));
        assert!(t.contains(&"baz".into()));
    }

    #[test]
    fn pipe_separator() {
        let t = tokenize("foo|bar");
        assert!(t.contains(&"foo".into()));
        assert!(t.contains(&"bar".into()));
    }

    #[test]
    fn diacritic_filter() {
        use tantivy::tokenizer::TokenFilter;
        let mut t = DiacriticFilter.transform(FerrisearchTokenizer::new());
        let mut stream = t.token_stream("café résumé");
        let mut out = Vec::new();
        while stream.advance() {
            out.push(stream.token().text.clone());
        }
        assert!(out.contains(&"cafe".into()));
        assert!(out.contains(&"resume".into()));
    }

    #[test]
    fn camel_case_in_tokenizer() {
        let t = tokenize("myVariableName");
        assert!(t.contains(&"myvariablename".into()));
        assert!(t.contains(&"my".into()));
        assert!(t.contains(&"variable".into()));
        assert!(t.contains(&"name".into()));
    }

    #[test]
    fn token_positions_increment() {
        let mut t = FerrisearchTokenizer::new();
        let mut stream = t.token_stream("hello world");
        let mut positions = Vec::new();
        while stream.advance() {
            positions.push(stream.token().position);
        }
        for w in positions.windows(2) {
            assert!(w[1] > w[0]);
        }
    }

    #[test]
    fn camel_case_shares_parent_position() {
        let mut t = FerrisearchTokenizer::new();
        let mut stream = t.token_stream("fooBar baz");
        let mut tokens = Vec::new();
        while stream.advance() {
            tokens.push((stream.token().text.clone(), stream.token().position));
        }
        assert!(tokens.contains(&("foobar".into(), 0)));
        assert!(tokens.contains(&("foo".into(), 0)));
        assert!(tokens.contains(&("bar".into(), 0)));
        assert!(tokens.contains(&("baz".into(), 1)));
    }

    #[test]
    fn token_offsets() {
        let mut t = FerrisearchTokenizer::new();
        let mut stream = t.token_stream("hello world");
        let mut found = false;
        while stream.advance() {
            if stream.token().text == "hello" {
                assert_eq!(stream.token().offset_from, 0);
                assert_eq!(stream.token().offset_to, 5);
                found = true;
            }
        }
        assert!(found);
    }
}
