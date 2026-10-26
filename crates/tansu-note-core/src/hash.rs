use std::fmt::Write as _;

pub fn source_hash(content: &str) -> String {
    format!("blake3-v3:{}", digest(normalize_lf(content).as_bytes()))
}

pub fn disk_hash(bytes: &[u8]) -> String {
    format!("blake3-v2:{}", digest(bytes))
}

pub fn normalize_lf(content: &str) -> String {
    content.replace("\r\n", "\n").replace('\r', "\n")
}

fn digest(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(64);
    for byte in blake3::hash(bytes).as_bytes() {
        write!(&mut hex, "{byte:02x}").expect("writing to String cannot fail");
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_hash_normalizes_line_endings_and_keeps_the_bom() {
        assert_eq!(
            source_hash("\u{feff}a\nb\nc\nd"),
            source_hash("\u{feff}a\r\nb\rc\nd")
        );
        assert_ne!(source_hash("a"), source_hash("\u{feff}a"));
        assert_eq!(
            source_hash("hello\n"),
            "blake3-v3:8e4c7c1b99dbfd50e7a95185fead5ee1448fa904a2fdd778eaf5f2dbfd629a99"
        );
    }

    #[test]
    fn disk_hash_uses_blake3_over_exact_bytes() {
        assert_eq!(
            disk_hash(b"hello\n"),
            "blake3-v2:8e4c7c1b99dbfd50e7a95185fead5ee1448fa904a2fdd778eaf5f2dbfd629a99"
        );
        assert_ne!(disk_hash(b"hello\n"), disk_hash(b"hello\r\n"));
    }
}
