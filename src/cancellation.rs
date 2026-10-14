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
    /// Creates a token that has not been canceled.
    pub fn new() -> Self {
        Self::default()
    }

    /// Signals cancellation to every clone; repeated calls have no effect.
    pub fn cancel(&self) {
        if self.0.cancelled.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok() {
            self.0.changed.notify(usize::MAX);
        }
    }

    /// Returns whether cancellation has been signaled.
    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::Acquire)
    }

    /// Resolves once cancellation has been signaled.
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
