import { mkdir, writeFile, rename, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import {
  LOCAL_MODEL,
  LOCAL_PROFILE,
  LOCAL_REVISION,
  modelDirectory,
} from "../backend/ai/local-model.mjs";
const expected = JSON.parse(
  await readFile(
    new URL(
      LOCAL_PROFILE === "chinese"
        ? "./ai-chinese-model-manifest.json"
        : "./ai-model-manifest.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const files = expected.files.map((x) => x.file);
const entries = [];
for (const file of files) {
  const path = resolve(modelDirectory(), file);
  await mkdir(dirname(path), { recursive: true });
  let data;
  try {
    data = await readFile(path);
  } catch {
    const response = await fetch(
      `https://huggingface.co/${LOCAL_MODEL}/resolve/${LOCAL_REVISION}/${file}`,
      { signal: AbortSignal.timeout(300000) },
    );
    if (!response.ok)
      throw Error(`Model download failed: ${file} (${response.status})`);
    data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > 256 * 1024 * 1024)
      throw Error("Invalid model file size");
    await writeFile(path + ".part", data);
    await rename(path + ".part", path);
  }
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (expected.files.find((x) => x.file === file)?.sha256 !== sha256)
    throw Error(
      `Model SHA256 mismatch: ${file}; remove only this damaged file and rerun setup`,
    );
  entries.push({ file, bytes: data.length, sha256 });
  console.log(`${file}: ${data.length} bytes`);
}
await writeFile(
  resolve(modelDirectory(), "manifest.json"),
  JSON.stringify(
    {
      model: LOCAL_MODEL,
      revision: LOCAL_REVISION,
      dtype: "q8",
      license: expected.license,
      files: entries,
    },
    null,
    2,
  ),
);
console.log(
  "Local model ready; online inference does not download model files.",
);
