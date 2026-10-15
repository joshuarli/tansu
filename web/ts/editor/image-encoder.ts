type WebpEncoder = {
  default: (image: ImageData) => Promise<Blob>;
};

export async function encodeImageDataAsWebp(image: ImageData): Promise<Blob> {
  const encoderUrl = new URL("/assets/jsquash-webp/encode.js", document.baseURI);
  const encoder = await import(encoderUrl.href) as WebpEncoder;
  return encoder.default(image);
}
