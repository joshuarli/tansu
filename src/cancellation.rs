use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use event_listener::Event;

/// A clonable one-shot signal shared by tasks that need cancellation.
#[derive(Clone, Default)]
pub struct CancellationToken(Arc<CancellationState>);

#[derive(Default)]
struct CancellationState {
    cancelled: AtomicBool,
    changed: Event,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// Repeated calls have no effect.
    pub fn cancel(&self) {
        if self.0.cancelled.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok() {
            self.0.changed.notify(usize::MAX);
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::Acquire)
    }

    pub async fn cancelled(&self) {
        loop {
            let listener = self.0.changed.listen();
            if self.is_cancelled() {
                return;
            }
            listener.await;
        }
    }
}
