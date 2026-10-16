import { defaultOptions } from "./meta.js";
import { initEmscriptenModule } from "./utils.js";
import webpEncoder from "./codec/enc/webp_enc.js";

let encoderModule;

export default async function encode(image, quality) {
  encoderModule ??= initEmscriptenModule(webpEncoder);
  const module = await encoderModule;
  const result = module.encode(image.data, image.width, image.height, { ...defaultOptions, quality: Math.round(quality * 100) });
  if (!result) throw new Error("WebP encoding failed");
  return new Blob([result], { type: "image/webp" });
}
