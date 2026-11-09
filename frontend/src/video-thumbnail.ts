export interface VideoThumbnail {
  pixels: ImageData;
  capturedAt: number;
}
export function validThumbnail(frame: VideoThumbnail) {
  const pixels = frame?.pixels;
  return (
    Number.isFinite(frame?.capturedAt) &&
    pixels &&
    Number.isInteger(pixels.width) &&
    Number.isInteger(pixels.height) &&
    pixels.width > 0 &&
    pixels.width <= 192 &&
    pixels.height > 0 &&
    pixels.height <= 108 &&
    pixels.data instanceof Uint8ClampedArray &&
    pixels.data.length === pixels.width * pixels.height * 4
  );
}
