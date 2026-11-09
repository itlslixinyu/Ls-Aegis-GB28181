import sharp from "sharp";
import { aiProblem } from "./settings.mjs";
export async function prepareAiImage(input, maxSide = 1280) {
  if (
    !Buffer.isBuffer(input) ||
    input.length < 16 ||
    input.length > 3 * 1024 * 1024
  )
    throw aiProblem(
      400,
      "INVALID_AI_IMAGE",
      "图片须为有效的JPEG、PNG、WebP或GIF，且不超过3MB",
    );
  try {
    const original = sharp(input, {
        limitInputPixels: 16_000_000,
        animated: false,
        failOn: "error",
      }),
      meta = await original.metadata();
    if (!["jpeg", "png", "webp", "gif"].includes(meta.format)) throw Error();
    const image = await original
      .rotate()
      .resize({
        width: maxSide,
        height: maxSide,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 82 })
      .toBuffer();
    const normalized = sharp(image),
      size = await normalized.metadata();
    const pixels = await normalized
      .clone()
      .resize(9, 8, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();
    let hash = 0n;
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++)
        hash =
          (hash << 1n) |
          BigInt(pixels[y * 9 + x] > pixels[y * 9 + x + 1] ? 1 : 0);
    return {
      image,
      hash: hash.toString(16).padStart(16, "0"),
      width: size.width,
      height: size.height,
    };
  } catch {
    throw aiProblem(
      400,
      "INVALID_AI_IMAGE",
      "图片无法解码或像素过大，请选择不超过1600万像素的常见图片",
    );
  }
}
export function decodeAiImage(value) {
  if (
    typeof value !== "string" ||
    value.length > 4 * 1024 * 1024 ||
    !/^data:image\/(jpeg|png|webp|gif);base64,[a-zA-Z0-9+/]+=*$/.test(value)
  )
    throw aiProblem(400, "INVALID_AI_IMAGE", "图片数据格式无效");
  const base64 = value.slice(value.indexOf(",") + 1),
    image = Buffer.from(base64, "base64");
  if (image.toString("base64") !== base64)
    throw aiProblem(400, "INVALID_AI_IMAGE", "图片编码无效");
  return image;
}
export function imageDistance(a, b) {
  if (!/^[a-f0-9]{16}$/.test(a || "") || !/^[a-f0-9]{16}$/.test(b || ""))
    return 64;
  let value = BigInt("0x" + a) ^ BigInt("0x" + b),
    count = 0;
  while (value) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}
