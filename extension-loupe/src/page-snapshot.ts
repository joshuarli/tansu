export const MAX_PAGE_SNAPSHOT_LENGTH = 8 * 1024 * 1024;

export function assertPageSnapshotWithinLimit(pageHtml: string): void {
  if (pageHtml.length > MAX_PAGE_SNAPSHOT_LENGTH) {
    throw new Error(
      `This page is too large for Loupe to read (maximum ${MAX_PAGE_SNAPSHOT_LENGTH.toLocaleString()} characters).`,
    );
  }
}
