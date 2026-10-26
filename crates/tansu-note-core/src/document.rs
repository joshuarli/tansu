use std::collections::{HashMap, VecDeque};

use crate::hash::disk_hash;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    Lf,
    CrLf,
    Cr,
}

impl LineEnding {
    fn bytes(self) -> &'static [u8] {
        match self {
            Self::Lf => b"\n",
            Self::CrLf => b"\r\n",
            Self::Cr => b"\r",
        }
    }

    fn index(self) -> usize {
        match self {
            Self::Lf => 0,
            Self::CrLf => 1,
            Self::Cr => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidUtf8;

impl std::fmt::Display for InvalidUtf8 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("markdown must be valid UTF-8")
    }
}

impl std::error::Error for InvalidUtf8 {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceNotLf;

impl std::fmt::Display for SourceNotLf {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("editor source must use LF line endings")
    }
}

impl std::error::Error for SourceNotLf {}

#[derive(Debug, Clone)]
pub struct SourceDocument {
    pub source: String,
    pub disk_bytes: Vec<u8>,
    pub line_endings: Vec<LineEnding>,
    dominant_line_ending: LineEnding,
}

impl SourceDocument {
    pub fn from_disk(bytes: &[u8]) -> Result<Self, InvalidUtf8> {
        let text = std::str::from_utf8(bytes).map_err(|_| InvalidUtf8)?;
        let mut source = String::with_capacity(text.len());
        let mut line_endings = Vec::new();
        let mut counts = [0_usize; 3];
        let mut chars = text.char_indices().peekable();
        while let Some((_, ch)) = chars.next() {
            match ch {
                '\r' => {
                    let ending = if matches!(chars.peek(), Some((_, '\n'))) {
                        chars.next();
                        LineEnding::CrLf
                    } else {
                        LineEnding::Cr
                    };
                    line_endings.push(ending);
                    counts[ending.index()] += 1;
                    source.push('\n');
                }
                '\n' => {
                    line_endings.push(LineEnding::Lf);
                    counts[LineEnding::Lf.index()] += 1;
                    source.push('\n');
                }
                _ => source.push(ch),
            }
        }
        let dominant_line_ending = if counts[0] >= counts[1] && counts[0] >= counts[2] {
            LineEnding::Lf
        } else if counts[1] >= counts[2] {
            LineEnding::CrLf
        } else {
            LineEnding::Cr
        };
        Ok(Self {
            source,
            disk_bytes: bytes.to_vec(),
            line_endings,
            dominant_line_ending,
        })
    }

    pub fn disk_hash(&self) -> String {
        disk_hash(&self.disk_bytes)
    }

    pub fn disk_bytes_for_source(&self, source: &str) -> Result<Vec<u8>, SourceNotLf> {
        if source == self.source {
            return Ok(self.disk_bytes.clone());
        }
        if source.contains('\r') {
            return Err(SourceNotLf);
        }
        let original_lines = self.source.split('\n').collect::<Vec<_>>();
        let mut original_positions = HashMap::<&str, VecDeque<usize>>::new();
        for (index, line) in original_lines.iter().enumerate() {
            if index < self.line_endings.len() {
                original_positions
                    .entry(line)
                    .or_default()
                    .push_back(index);
            }
        }
        let mut last_original_line = None;
        let candidate_lines = source.split('\n').collect::<Vec<_>>();
        let mut bytes = Vec::with_capacity(source.len() + self.line_endings.len());
        for (index, line) in candidate_lines.iter().enumerate() {
            bytes.extend_from_slice(line.as_bytes());
            if index + 1 == candidate_lines.len() {
                continue;
            }
            let ending = original_positions
                .get_mut(line)
                .and_then(|positions| {
                    while positions.front().is_some_and(|position| {
                        last_original_line.is_some_and(|last| *position <= last)
                    }) {
                        positions.pop_front();
                    }
                    positions.pop_front()
                })
                .map(|line| {
                    last_original_line = Some(line);
                    self.line_endings[line]
                })
                .unwrap_or(self.dominant_line_ending);
            bytes.extend_from_slice(ending.bytes());
        }
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_document_preserves_untouched_endings_and_uses_dominant_for_inserted_lines() {
        let source = SourceDocument::from_disk(b"a\r\nb\nc\r").unwrap();
        assert_eq!(source.source, "a\nb\nc\n");
        assert_eq!(source.line_endings, vec![LineEnding::CrLf, LineEnding::Lf, LineEnding::Cr]);
        assert_eq!(
            source.disk_bytes_for_source("a\ninserted\nb\nc\n").unwrap(),
            b"a\r\ninserted\nb\nc\r"
        );
    }

    #[test]
    fn source_document_preserves_original_bytes_for_no_op_edits() {
        for bytes in [b"\xef\xbb\xbfalpha\r\n\r\nomega".as_slice(), b"x\rY\nZ"] {
            let source = SourceDocument::from_disk(bytes).unwrap();
            assert_eq!(source.disk_bytes_for_source(&source.source).unwrap(), bytes);
        }
    }

    #[test]
    fn source_document_rejects_invalid_utf8_and_carriage_returns_in_new_source() {
        assert_eq!(SourceDocument::from_disk(b"\xff").unwrap_err(), InvalidUtf8);
        let source = SourceDocument::from_disk(b"a\n").unwrap();
        assert_eq!(source.disk_bytes_for_source("b\r\n").unwrap_err(), SourceNotLf);
    }
}
