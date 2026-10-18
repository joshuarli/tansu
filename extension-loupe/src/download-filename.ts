export function sanitizeDownloadFilename(unsanitizedFilename: string): string {
  const sanitizedFilename = unsanitizedFilename
    .trim()
    .replaceAll(/[^a-zA-Z0-9._() -]+/g, "-")
    .replaceAll(/\s+/g, " ")
    .replace(/^\.+/, "")
    .replaceAll(/[. ]+$/g, "")
    .slice(0, 120);
  return sanitizedFilename || "page";
}
