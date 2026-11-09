import { readFile, writeFile } from "node:fs/promises";
import {
  LocalModel,
  LOCAL_VERSION,
  localText,
  cosine,
} from "../backend/ai/local-model.mjs";
const source = process.argv[2];
if (!source)
  throw Error(
    "Usage: node scripts/benchmark-ai-local.mjs <local-image> [report.json]",
  );
const bytes = await readFile(source);
if (bytes.length > 3 * 1048576) throw Error("Image exceeds 3 MiB");
const local = new LocalModel();
try {
  const image = bytes.toString("base64");
  const cold = await local.run({ image });
  const warm = [];
  for (let i = 0; i < 5; i++) warm.push(await local.run({ image }));
  const text = await local.run({ text: localText("白色汽车") });
  const report = {
    model: LOCAL_VERSION,
    time: new Date().toISOString(),
    device: "CPU",
    threads: 1,
    imageColdMs: cold.ms,
    imageWarmMs: warm.map((x) => x.ms),
    textColdMs: text.ms,
    peakWorkerMiB: Math.ceil(
      Math.max(cold.rss, text.rss, ...warm.map((x) => x.rss)) / 1048576,
    ),
    identicalImageCosine: cosine(cold.embedding, warm[0].embedding),
    textSimilarity: cosine(cold.embedding, text.embedding),
    scope: "单张既有录像画面的模型基准，不代表64路吞吐或检索准确率",
  };
  if (process.argv[3])
    await writeFile(process.argv[3], JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  local.close();
}
