import { uploadImage } from "./api.ts";
import { markDirty } from "./tabs.ts";
import { escapeHtml, stemFromPath } from "./util.ts";

/// Handle pasted image: convert to webp, upload, insert wiki-link.
export async function handleImagePaste(item: DataTransferItem, currentPath: string | null) {
  const file = item.getAsFile();
  if (!file) return;

  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
  bitmap.close();

  const now = new Date();
  const ts =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0");

  const noteName = currentPath ? stemFromPath(currentPath) : "image";
  const filename = `${noteName} ${ts}.webp`;

  try {
    const savedName = await uploadImage(blob, filename);
    const src = `/z-images/${encodeURIComponent(savedName)}`;
    const html = `<img src="${escapeHtml(src)}" alt="${escapeHtml(savedName)}" data-wiki-image="${escapeHtml(savedName)}" loading="lazy">`;
    document.execCommand("insertHTML", false, html);
    if (currentPath) markDirty(currentPath);
  } catch (e) {
    console.error("Image upload failed:", e);
  }
}
