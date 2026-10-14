use std::cell::Cell;

use crate::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FailurePoint {
    IntentCommitted,
    SnapshotWritePermissionDenied,
    SnapshotWritten,
    CatalogTransitionCommitted,
    VisibleFileStorageFull,
    VisibleFileReplaced,
    DirectorySynced,
    CompletionCommitted,
    BeforeEventPublish,
    AfterEventPublish,
    WatcherReconciled,
    ResponseReady,
}

thread_local! {
    static NEXT_FAILURE: Cell<Option<FailurePoint>> = const { Cell::new(None) };
}

pub(crate) fn inject(point: FailurePoint) {
    NEXT_FAILURE.with(|next| {
        assert!(next.replace(Some(point)).is_none());
    });
}

pub(crate) fn check(point: FailurePoint) -> Result<()> {
    let fail = NEXT_FAILURE.with(|next| {
        if next.get() == Some(point) {
            next.set(None);
            true
        } else {
            false
        }
    });
    if fail {
        let error = match point {
            FailurePoint::SnapshotWritePermissionDenied => Error::Io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected snapshot permission failure",
            )),
            FailurePoint::VisibleFileStorageFull => Error::Io(std::io::Error::new(
                std::io::ErrorKind::StorageFull,
                "injected visible file storage failure",
            )),
            _ => Error::Internal(format!("injected failure at {point:?}")),
        };
        Err(error)
    } else {
        Ok(())
    }
}

pub(crate) fn is_armed() -> bool {
    NEXT_FAILURE.with(|next| next.get().is_some())
}
