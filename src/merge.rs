/// Line-based 3-way merge.
/// Returns Ok(merged) on success, Err(()) if there are conflicts.

pub fn merge3(base: &str, ours: &str, theirs: &str) -> Result<String, ()> {
    let base_lines: Vec<&str> = base.lines().collect();
    let our_lines: Vec<&str> = ours.lines().collect();
    let their_lines: Vec<&str> = theirs.lines().collect();

    // Simple LCS-based diff and merge
    let our_diff = diff(&base_lines, &our_lines);
    let their_diff = diff(&base_lines, &their_lines);

    // Walk both diffs together
    let mut result = Vec::new();
    let mut bi = 0usize;
    let mut oi = 0usize;
    let mut ti = 0usize;

    while bi < base_lines.len() || oi < our_lines.len() || ti < their_lines.len() {
        let our_changed = our_diff.get(bi).copied().unwrap_or(DiffOp::Delete);
        let their_changed = their_diff.get(bi).copied().unwrap_or(DiffOp::Delete);

        match (our_changed, their_changed) {
            (DiffOp::Keep, DiffOp::Keep) => {
                result.push(base_lines[bi]);
                bi += 1;
                oi += 1;
                ti += 1;
            }
            (DiffOp::Keep, DiffOp::Delete) => {
                // Theirs deleted this line
                bi += 1;
                oi += 1;
            }
            (DiffOp::Delete, DiffOp::Keep) => {
                // Ours deleted this line
                bi += 1;
                ti += 1;
            }
            (DiffOp::Delete, DiffOp::Delete) => {
                // Both deleted
                bi += 1;
            }
            (DiffOp::Replace, DiffOp::Keep) => {
                // Ours modified, theirs kept original
                if oi < our_lines.len() {
                    result.push(our_lines[oi]);
                    oi += 1;
                }
                bi += 1;
                ti += 1;
            }
            (DiffOp::Keep, DiffOp::Replace) => {
                // Theirs modified, ours kept original
                if ti < their_lines.len() {
                    result.push(their_lines[ti]);
                    ti += 1;
                }
                bi += 1;
                oi += 1;
            }
            (DiffOp::Replace, DiffOp::Replace) => {
                // Both modified the same line — conflict
                if oi < our_lines.len() && ti < their_lines.len()
                    && our_lines[oi] == their_lines[ti]
                {
                    // Same change, no conflict
                    result.push(our_lines[oi]);
                    oi += 1;
                    ti += 1;
                    bi += 1;
                } else {
                    return Err(());
                }
            }
            (DiffOp::Replace, DiffOp::Delete) | (DiffOp::Delete, DiffOp::Replace) => {
                // One deleted, other modified — conflict
                return Err(());
            }
        }
    }

    // Append any trailing lines from ours or theirs
    while oi < our_lines.len() {
        result.push(our_lines[oi]);
        oi += 1;
    }
    while ti < their_lines.len() {
        result.push(their_lines[ti]);
        ti += 1;
    }

    Ok(result.join("\n"))
}

#[derive(Clone, Copy, PartialEq)]
enum DiffOp {
    Keep,
    Delete,
    Replace,
}

/// Produce a per-base-line diff indicating what happened to each base line.
fn diff<'a>(base: &[&'a str], modified: &[&'a str]) -> Vec<DiffOp> {
    let n = base.len();
    let m = modified.len();

    // LCS table
    let mut table = vec![vec![0u32; m + 1]; n + 1];
    for i in 1..=n {
        for j in 1..=m {
            if base[i - 1] == modified[j - 1] {
                table[i][j] = table[i - 1][j - 1] + 1;
            } else {
                table[i][j] = table[i - 1][j].max(table[i][j - 1]);
            }
        }
    }

    // Backtrack to get per-base-line operations
    let mut ops = vec![DiffOp::Delete; n];
    let mut i = n;
    let mut j = m;
    while i > 0 && j > 0 {
        if base[i - 1] == modified[j - 1] {
            ops[i - 1] = DiffOp::Keep;
            i -= 1;
            j -= 1;
        } else if table[i - 1][j] >= table[i][j - 1] {
            // Base line was deleted or replaced
            // Check if there's a corresponding modified line
            ops[i - 1] = DiffOp::Replace;
            i -= 1;
        } else {
            // Modified has an insertion
            j -= 1;
        }
    }
    // Remaining base lines are deletions
    while i > 0 {
        ops[i - 1] = DiffOp::Delete;
        i -= 1;
    }

    ops
}
