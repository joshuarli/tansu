import { encodeImageDataAsWebp } from "./image-encoder.js";
import type { EditorImageUploadResult } from "./tansu-extensions.js";

export async function convertImageToWebp(file: Blob, quality: number): Promise<Blob> {
  if (file.type === "image/webp") return file;
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  try {
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Could not create an image conversion context");
    context.drawImage(bitmap, 0, 0);
    const image = await encodeImageDataAsWebp(context.getImageData(0, 0, bitmap.width, bitmap.height), quality);
    if (image.type !== "image/webp") throw new Error("Browser did not convert the image to WebP");
    return image;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    bitmap.close();
  }
}

export function webpAssetMarkdown(result: EditorImageUploadResult): string {
  const prefix = "z-images/";
  const assetName = result.name.startsWith(prefix) ? result.name.slice(prefix.length) : "";
  if (
    assetName === "" ||
    assetName.includes("/") ||
    assetName.includes("\\") ||
    !assetName.endsWith(".webp") ||
    result.markdown.trim() === ""
  ) {
    throw new TypeError("Image upload returned an invalid WebP asset");
  }
  return result.markdown;
}
