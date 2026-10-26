use tansu_api_types::{TextEdit, TextPosition};

use crate::hash::normalize_lf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextEditError {
    CarriageReturnInText,
    ReversedRange,
    UnsortedOrOverlapping,
    PositionOutsideDocument,
    SplitSurrogatePair,
}

impl std::fmt::Display for TextEditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::CarriageReturnInText => "delta edit text contains CR",
            Self::ReversedRange => "delta edit range is reversed",
            Self::UnsortedOrOverlapping => "delta edits must be sorted and non-overlapping",
            Self::PositionOutsideDocument => "delta edit position is outside the base document",
            Self::SplitSurrogatePair => "delta edit position splits a UTF-16 surrogate pair",
        })
    }
}

impl std::error::Error for TextEditError {}

pub fn apply_text_edits(base: &str, edits: &[TextEdit]) -> Result<String, TextEditError> {
    let base = normalize_lf(base);
    let mut ranges = Vec::with_capacity(edits.len());
    let mut previous: Option<(&TextPosition, &TextPosition)> = None;
    for edit in edits {
        if edit.text.contains('\r') {
            return Err(TextEditError::CarriageReturnInText);
        }
        if compare_position(&edit.start, &edit.end).is_gt() {
            return Err(TextEditError::ReversedRange);
        }
        if let Some((previous_start, previous_end)) = previous
            && (compare_position(&edit.start, previous_start).is_eq()
                || compare_position(&edit.start, previous_end).is_lt())
        {
            return Err(TextEditError::UnsortedOrOverlapping);
        }
        let start = text_position_to_byte_offset(&base, &edit.start)?;
        let end = text_position_to_byte_offset(&base, &edit.end)?;
        if start > end {
            return Err(TextEditError::ReversedRange);
        }
        ranges.push((start, end, edit.text.as_str()));
        previous = Some((&edit.start, &edit.end));
    }

    let mut content = base;
    for (start, end, text) in ranges.into_iter().rev() {
        content.replace_range(start..end, text);
    }
    Ok(content)
}

fn compare_position(left: &TextPosition, right: &TextPosition) -> std::cmp::Ordering {
    left.line
        .cmp(&right.line)
        .then_with(|| left.character.cmp(&right.character))
}

fn text_position_to_byte_offset(content: &str, position: &TextPosition) -> Result<usize, TextEditError> {
    let mut line_start = 0;
    for (line, segment) in content.split('\n').enumerate() {
        if line == position.line {
            return utf16_character_to_byte_offset(segment, position.character)
                .map(|column| line_start + column);
        }
        line_start += segment.len() + 1;
    }
    Err(TextEditError::PositionOutsideDocument)
}

fn utf16_character_to_byte_offset(line: &str, character: usize) -> Result<usize, TextEditError> {
    let mut utf16_offset = 0;
    for (byte_offset, ch) in line.char_indices() {
        if utf16_offset == character {
            return Ok(byte_offset);
        }
        utf16_offset += ch.len_utf16();
        if utf16_offset > character {
            return Err(TextEditError::SplitSurrogatePair);
        }
    }
    if utf16_offset == character {
        Ok(line.len())
    } else {
        Err(TextEditError::PositionOutsideDocument)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(start: (usize, usize), end: (usize, usize), text: &str) -> TextEdit {
        TextEdit {
            start: TextPosition { line: start.0, character: start.1 },
            end: TextPosition { line: end.0, character: end.1 },
            text: text.to_string(),
        }
    }

    #[test]
    fn text_edits_apply_utf16_ranges_and_multiline_text() {
        let content = apply_text_edits(
            "alpha\nemoji 😀\nomega\n",
            &[edit((1, 6), (1, 8), "😁"), edit((2, 5), (2, 5), "\ntrail")],
        )
        .unwrap();

        assert_eq!(content, "alpha\nemoji 😁\nomega\ntrail\n");
    }

    #[test]
    fn text_edits_reject_invalid_ranges() {
        assert_eq!(
            apply_text_edits("😀\n", &[edit((0, 1), (0, 1), "x")]),
            Err(TextEditError::SplitSurrogatePair)
        );
        assert_eq!(
            apply_text_edits("abcd", &[edit((0, 1), (0, 3), "x"), edit((0, 2), (0, 4), "y")]),
            Err(TextEditError::UnsortedOrOverlapping)
        );
        assert_eq!(
            apply_text_edits("abcd", &[edit((0, 3), (0, 1), "x")]),
            Err(TextEditError::ReversedRange)
        );
        assert_eq!(
            apply_text_edits("abcd", &[edit((0, 0), (0, 0), "x\r")]),
            Err(TextEditError::CarriageReturnInText)
        );
        assert_eq!(
            apply_text_edits("abcd", &[edit((1, 0), (1, 0), "x")]),
            Err(TextEditError::PositionOutsideDocument)
        );
        assert_eq!(
            apply_text_edits("abcd", &[edit((0, 0), (0, 5), "x")]),
            Err(TextEditError::PositionOutsideDocument)
        );
    }
}
