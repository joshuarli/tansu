/// Extension trait for safe string truncation at character boundaries.
///
/// Both methods avoid the "byte index is not a char boundary" panic that
/// occurs when naively slicing `&s[..n]` with a value derived from a byte
/// count or an unchecked user-supplied limit.
pub trait StrExt {
    /// Truncate to at most `n` characters (Unicode scalar values).
    fn truncate_chars(&self, n: usize) -> &str;

    /// Truncate to at most `n` bytes, snapping back to the nearest valid
    /// char boundary if `n` falls inside a multi-byte character.
    fn truncate_bytes(&self, n: usize) -> &str;
}

impl StrExt for str {
    fn truncate_chars(&self, n: usize) -> &str {
        match self.char_indices().nth(n) {
            Some((i, _)) => &self[..i],
            None => self,
        }
    }

    fn truncate_bytes(&self, n: usize) -> &str {
        &self[..self.floor_char_boundary(n.min(self.len()))]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_bytes_mid_emoji() {
        let s = "hello 📖 world";
        // 📖 is at bytes 6..10; truncating at 8 should snap back to 6
        assert_eq!(s.truncate_bytes(8), "hello ");
    }

    #[test]
    fn truncate_bytes_at_boundary() {
        assert_eq!("hello".truncate_bytes(5), "hello");
        assert_eq!("hello".truncate_bytes(100), "hello");
    }

    #[test]
    fn truncate_chars_basic() {
        assert_eq!("hello 📖 world".truncate_chars(7), "hello 📖");
        assert_eq!("abc".truncate_chars(100), "abc");
    }
}
