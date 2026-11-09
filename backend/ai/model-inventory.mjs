import { existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  LOCAL_PROFILE,
  modelDirectory,
  localModelReady,
} from "./local-model.mjs";
// Inventory is metadata only: never load a model or download weights on HTTP requests.
export function localModelInventory(root = resolve("data/ai-models")) {
  return [
    {
      id: "chinese",
      name: "Chinese-CLIP ViT-B/16",
      directory: "chinese-clip-vit-base-patch16",
      files: ["onnx/model_quantized.onnx"],
      purpose: "中文描述搜画面、以图搜图",
      license: "MIT（上游项目）",
    },
    {
      id: "qwen",
      name: "Qwen3-VL 2B · Q4_K_M",
      directory: "qwen3-vl-2b-q4",
      files: [
        "Qwen3VL-2B-Instruct-Q4_K_M.gguf",
        "mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf",
      ],
      purpose: "本地告警图片中文描述与标签，单任务低频分析，不外发图片",
      license: "Apache-2.0",
    },
  ].map((m) => {
    const selected = m.id === LOCAL_PROFILE;
    const directory = selected ? modelDirectory() : join(root, m.directory);
    const installed = m.files.every((f) => existsSync(join(directory, f)));
    return {
      id: m.id,
      name: m.name,
      purpose: m.purpose,
      license: m.license,
      installed,
      selected,
      ready: selected ? localModelReady() : false,
      bytes: installed
        ? m.files.reduce((sum, f) => sum + statSync(join(directory, f)).size, 0)
        : 0,
      benchmark: null,
    };
  });
}
