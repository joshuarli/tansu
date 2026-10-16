type WebpEncoder = {
  default: (image: ImageData) => Promise<Blob>;
};

export async function encodeImageDataAsWebp(image: ImageData): Promise<Blob> {
  const encoderPath = process.env["TANSU2_WEBP_ENCODER_URL"];
  if (!encoderPath) throw new Error("WebP encoder URL was not injected at build time");
  const encoderUrl = new URL(encoderPath, document.baseURI);
  const encoder = await import(encoderUrl.href) as WebpEncoder;
  return encoder.default(image);
}
