type RevisionRestorePayload = {
  content: string;
  mtime: number;
};

let restoreHandler: ((payload: RevisionRestorePayload) => void) | null = null;

export function setRevisionRestoreHandler(
  handler: ((payload: RevisionRestorePayload) => void) | null,
): void {
  restoreHandler = handler;
}

export function restoreRevisionIntoEditor(payload: RevisionRestorePayload): void {
  restoreHandler?.(payload);
}
