import {
  AutoTokenizer,
  AutoProcessor,
  CLIPTextModelWithProjection,
  ChineseCLIPModel,
  CLIPVisionModelWithProjection,
  RawImage,
  env,
} from "@huggingface/transformers";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { join } from "node:path";
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useFSCache = false;
const directory = process.env.AI_LOCAL_MODEL_DIR;
let tokenizer, processor, textModel, imageModel, chineseModel, dummyPixels;
const chinese =
  JSON.parse(readFileSync(join(directory, "config.json"), "utf8"))
    .model_type === "chinese_clip";
const options = {
  local_files_only: true,
  dtype: "q8",
  device: "cpu",
  session_options: {
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    executionMode: "sequential",
  },
};
process.on("message", async ({ id, image, text }) => {
  const started = performance.now();
  try {
    let embedding;
    if (chinese) {
      tokenizer ||= await AutoTokenizer.from_pretrained(directory, {
        local_files_only: true,
      });
      processor ||= await AutoProcessor.from_pretrained(directory, {
        local_files_only: true,
      });
      chineseModel ||= await ChineseCLIPModel.from_pretrained(
        directory,
        options,
      );
      let pixels;
      if (image) {
        const { data, info } = await sharp(Buffer.from(image, "base64"))
          .removeAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        pixels = await processor(
          new RawImage(
            new Uint8ClampedArray(data),
            info.width,
            info.height,
            info.channels,
          ),
        );
      } else {
        dummyPixels ||= await processor(
          new RawImage(new Uint8ClampedArray(224 * 224 * 3), 224, 224, 3),
        );
        pixels = dummyPixels;
      }
      const chars = Array.from(text || ""),
        parts = [];
      if (image) parts.push("图像");
      else
        for (let i = 0; i < chars.length; i += 40)
          parts.push(chars.slice(i, i + 40).join(""));
      embedding = Array(512).fill(0);
      for (const part of parts) {
        const tokens = await tokenizer(part, {
          padding: true,
          truncation: true,
          max_length: 52,
        });
        const output = await chineseModel({ ...tokens, ...pixels });
        const vector = (image ? output.image_embeds : output.text_embeds).data;
        for (let i = 0; i < 512; i++) embedding[i] += vector[i] / parts.length;
      }
    } else if (image) {
      processor ||= await AutoProcessor.from_pretrained(directory, {
        local_files_only: true,
      });
      imageModel ||= await CLIPVisionModelWithProjection.from_pretrained(
        directory,
        options,
      );
      const { data, info } = await sharp(Buffer.from(image, "base64"))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const output = await imageModel(
        await processor(
          new RawImage(
            new Uint8ClampedArray(data),
            info.width,
            info.height,
            info.channels,
          ),
        ),
      );
      embedding = Array.from(output.image_embeds.data);
    } else {
      tokenizer ||= await AutoTokenizer.from_pretrained(directory, {
        local_files_only: true,
      });
      textModel ||= await CLIPTextModelWithProjection.from_pretrained(
        directory,
        options,
      );
      const output = await textModel(
        await tokenizer(text, { padding: true, truncation: true }),
      );
      embedding = Array.from(output.text_embeds.data);
    }
    if (embedding.length !== 512 || embedding.some((x) => !Number.isFinite(x)))
      throw new Error("Invalid embedding");
    process.send({
      id,
      embedding,
      ms: Math.round(performance.now() - started),
      rss: process.memoryUsage().rss,
    });
  } catch {
    process.send({ id, error: true });
  }
});
