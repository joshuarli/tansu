#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SearchWeightPolicy {
    pub title: f32,
    pub headings: f32,
    pub tags: f32,
    pub content: f32,
    pub recency_boost: f32,
}

impl SearchWeightPolicy {
    pub const MAX: f32 = 1000.0;
    pub const DEFAULT: Self = Self {
        title: 10.0,
        headings: 5.0,
        tags: 2.0,
        content: 1.0,
        recency_boost: 0.0,
    };
}
