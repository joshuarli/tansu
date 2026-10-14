use std::collections::{HashMap, HashSet};

use nucleo_matcher::pattern::{Atom, AtomKind, CaseMatching, Normalization};
use nucleo_matcher::{Config, Matcher, Utf32Str};

use crate::error::SearchError;
use crate::types::{
    NoteIdentity, QuickOpenField, QuickOpenHit, QuickOpenPriority, QuickOpenRange,
    QuickOpenResponse, SearchLimit,
};

struct Candidate {
    hit: QuickOpenHit,
    field_order: usize,
    score: u16,
}

pub(crate) fn search(
    query: &str,
    identities: &[NoteIdentity],
    pinned: &[String],
    recent: &[String],
    limit: SearchLimit,
) -> Result<QuickOpenResponse, SearchError> {
    if query.len() > 1024 {
        return Err(SearchError::QueryTooLong {
            bytes: query.len(),
            maximum: 1024,
        });
    }
    if query.trim().is_empty() {
        return Ok(empty_query(identities, pinned, recent, limit));
    }
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let exact = Atom::new(
        query,
        CaseMatching::Ignore,
        Normalization::Smart,
        AtomKind::Exact,
        false,
    );
    let prefix = Atom::new(
        query,
        CaseMatching::Ignore,
        Normalization::Smart,
        AtomKind::Prefix,
        false,
    );
    let fuzzy = Atom::new(
        query,
        CaseMatching::Ignore,
        Normalization::Smart,
        AtomKind::Fuzzy,
        false,
    );
    let mut candidates = Vec::new();
    for identity in identities {
        let path = identity.path();
        let filename = path.rsplit('/').next().unwrap_or(path).trim_end_matches(".md");
        let fields = [
            (identity.title(), QuickOpenField::Title),
            (filename, QuickOpenField::Filename),
            (path, QuickOpenField::Path),
        ];
        let mut best = None;
        for (field_order, (text, field)) in fields.into_iter().enumerate() {
            if let Some((priority, score, indices)) =
                matched_indices(text, &exact, &prefix, &fuzzy, &mut matcher)
            {
                let ranges = codepoint_ranges(text, field, &indices)?;
                let candidate = Candidate {
                    hit: QuickOpenHit {
                        identity: identity.clone(),
                        priority,
                        score,
                        ranges,
                    },
                    field_order,
                    score,
                };
                let replace = best.as_ref().is_none_or(|current: &Candidate| {
                    candidate_order(&candidate, current).is_lt()
                });
                if replace {
                    best = Some(candidate);
                }
            }
        }
        if let Some(candidate) = best {
            candidates.push(candidate);
        }
    }
    candidates.sort_by(candidate_order);
    candidates.truncate(limit.get());
    Ok(QuickOpenResponse {
        hits: candidates.into_iter().map(|candidate| candidate.hit).collect(),
    })
}

fn matched_indices(
    text: &str,
    exact: &Atom,
    prefix: &Atom,
    fuzzy: &Atom,
    matcher: &mut Matcher,
) -> Option<(QuickOpenPriority, u16, Vec<u32>)> {
    let chars = text.chars().collect::<Vec<_>>();
    let haystack = Utf32Str::Unicode(&chars);
    let mut indices = Vec::new();
    if let Some(score) = exact.indices(haystack, matcher, &mut indices) {
        return Some((QuickOpenPriority::Exact, score, indices));
    }
    indices.clear();
    if let Some(score) = prefix.indices(haystack, matcher, &mut indices) {
        return Some((QuickOpenPriority::Prefix, score, indices));
    }
    indices.clear();
    fuzzy
        .indices(haystack, matcher, &mut indices)
        .map(|score| (QuickOpenPriority::Subsequence, score, indices))
}

fn codepoint_ranges(
    text: &str,
    field: QuickOpenField,
    indices: &[u32],
) -> Result<Vec<QuickOpenRange>, SearchError> {
    let mut offsets = Vec::with_capacity(text.chars().count());
    let mut utf16_offset = 0u32;
    for character in text.chars() {
        let start = utf16_offset;
        utf16_offset = utf16_offset
            .checked_add(character.len_utf16() as u32)
            .ok_or(SearchError::CorruptIndex)?;
        offsets.push((start, utf16_offset));
    }
    let mut sorted = indices.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut ranges = Vec::new();
    let mut start = None;
    let mut end = 0;
    let mut previous = None;
    for index in sorted {
        let Some((range_start, range_end)) = offsets.get(index as usize) else {
            return Err(SearchError::CorruptIndex);
        };
        if previous.is_some_and(|previous| previous + 1 != index) {
            ranges.push(QuickOpenRange::new(field, start.unwrap(), end)?);
            start = None;
        }
        if start.is_none() {
            start = Some(*range_start);
        }
        end = *range_end;
        previous = Some(index);
    }
    if let Some(start) = start {
        ranges.push(QuickOpenRange::new(field, start, end)?);
    }
    Ok(ranges)
}

fn empty_query(
    identities: &[NoteIdentity],
    pinned: &[String],
    recent: &[String],
    limit: SearchLimit,
) -> QuickOpenResponse {
    if limit.get() == 0 {
        return QuickOpenResponse { hits: Vec::new() };
    }
    let by_id = identities
        .iter()
        .map(|identity| (identity.note_id(), identity))
        .collect::<HashMap<_, _>>();
    let mut seen = HashSet::new();
    let mut hits = Vec::new();
    for (ids, priority) in [
        (pinned, QuickOpenPriority::Pinned),
        (recent, QuickOpenPriority::Recent),
    ] {
        for note_id in ids {
            if !seen.insert(note_id.as_str()) {
                continue;
            }
            if let Some(identity) = by_id.get(note_id.as_str()) {
                hits.push(QuickOpenHit {
                    identity: (*identity).clone(),
                    priority,
                    score: 0,
                    ranges: Vec::new(),
                });
                if hits.len() >= limit.get() {
                    return QuickOpenResponse { hits };
                }
            }
        }
    }
    QuickOpenResponse { hits }
}

fn candidate_order(left: &Candidate, right: &Candidate) -> std::cmp::Ordering {
    left.hit
        .priority
        .cmp(&right.hit.priority)
        .then_with(|| left.field_order.cmp(&right.field_order))
        .then_with(|| right.score.cmp(&left.score))
        .then_with(|| left.hit.identity.path().cmp(right.hit.identity.path()))
        .then_with(|| left.hit.identity.note_id().cmp(right.hit.identity.note_id()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(note_id: &str, path: &str, title: &str) -> NoteIdentity {
        NoteIdentity::new(
            note_id.into(),
            path.into(),
            title.into(),
            vec![],
            1,
            "sha256-v2:test".into(),
        )
        .unwrap()
    }

    #[test]
    fn exact_then_prefix_then_subsequence_order() {
        let identities = [
            identity("1", "apple.md", "apple"),
            identity("2", "other.md", "apple pie"),
            identity("3", "last.md", "a__p__p__l__e"),
        ];
        let result = search("apple", &identities, &[], &[], SearchLimit::try_from(10).unwrap())
            .unwrap();
        assert_eq!(
            result.hits.iter().map(|hit| hit.identity.note_id()).collect::<Vec<_>>(),
            ["1", "2", "3"]
        );
        assert_eq!(result.hits[0].priority, QuickOpenPriority::Exact);
        assert_eq!(result.hits[1].priority, QuickOpenPriority::Prefix);
        assert_eq!(result.hits[2].priority, QuickOpenPriority::Subsequence);
    }

    #[test]
    fn empty_query_returns_pins_then_recents_without_full_text_search() {
        let identities = [
            identity("1", "one.md", "One"),
            identity("2", "two.md", "Two"),
        ];
        let result = search(
            "  ",
            &identities,
            &["2".into(), "missing".into()],
            &["2".into(), "1".into()],
            SearchLimit::try_from(10).unwrap(),
        )
        .unwrap();
        assert_eq!(
            result.hits.iter().map(|hit| hit.identity.note_id()).collect::<Vec<_>>(),
            ["2", "1"]
        );
        assert_eq!(result.hits[0].priority, QuickOpenPriority::Pinned);
        assert_eq!(result.hits[1].priority, QuickOpenPriority::Recent);
    }

    #[test]
    fn combining_and_supplementary_characters_map_to_utf16_ranges() {
        let identities = [identity("1", "note.md", "e\u{301}😀x")];
        let result = search("😀", &identities, &[], &[], SearchLimit::try_from(10).unwrap())
            .unwrap();
        let range = &result.hits[0].ranges[0];
        assert_eq!((range.start(), range.end()), (2, 4));
    }

    #[test]
    fn ties_are_stable_by_path_then_note_id() {
        let identities = [
            identity("b", "z.md", "title"),
            identity("a", "a.md", "title"),
        ];
        let result = search("title", &identities, &[], &[], SearchLimit::try_from(10).unwrap())
            .unwrap();
        assert_eq!(
            result.hits.iter().map(|hit| hit.identity.path()).collect::<Vec<_>>(),
            ["a.md", "z.md"]
        );
    }
}
