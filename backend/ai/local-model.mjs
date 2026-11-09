import { fork } from "node:child_process";
import { setPriority, constants } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { aiProblem } from "./settings.mjs";

export const LOCAL_PROFILE = process.env.AI_LOCAL_MODEL_PROFILE || "chinese";
if (!["chinese", "english"].includes(LOCAL_PROFILE))
  throw Error("AI_LOCAL_MODEL_PROFILE must be chinese or english");
export const LOCAL_MODEL =
  LOCAL_PROFILE === "chinese"
    ? "Xenova/chinese-clip-vit-base-patch16"
    : "Xenova/clip-vit-base-patch32";
export const LOCAL_REVISION =
  LOCAL_PROFILE === "chinese"
    ? "f26904860903e70e050b8f48255e5f48401816e9"
    : "6b7c523703ae26e39be4b03774966f8571c7f523";
export const LOCAL_VERSION = `${LOCAL_MODEL}@${LOCAL_REVISION}:q8:224`;
export const LOCAL_STARTUP_MIB = LOCAL_PROFILE === "chinese" ? 768 : 384;
export const modelDirectory = () =>
  resolve(
    process.env.AI_LOCAL_MODEL_DIR ||
      `data/ai-models/${LOCAL_PROFILE === "chinese" ? "chinese-clip-vit-base-patch16" : "clip-vit-base-patch32"}`,
  );
export const localModelReady = () => {
  const files = [
    "config.json",
    "tokenizer.json",
    "preprocessor_config.json",
    "manifest.json",
    ...(LOCAL_PROFILE === "chinese"
      ? ["onnx/model_quantized.onnx"]
      : ["onnx/text_model_quantized.onnx", "onnx/vision_model_quantized.onnx"]),
  ].every((f) => existsSync(resolve(modelDirectory(), f)));
  if (!files) return false;
  try {
    const config = JSON.parse(
      readFileSync(resolve(modelDirectory(), "config.json"), "utf8"),
    );
    const manifest = JSON.parse(
      readFileSync(resolve(modelDirectory(), "manifest.json"), "utf8"),
    );
    return (
      config.model_type ===
        (LOCAL_PROFILE === "chinese" ? "chinese_clip" : "clip") &&
      manifest.model === LOCAL_MODEL &&
      manifest.revision === LOCAL_REVISION
    );
  } catch {
    return false;
  }
};

// One isolated, single-threaded CPU worker. No model download on a web request.
export class LocalModel {
  constructor() {
    this.child = null;
    this.busy = false;
    this.sequence = 0;
  }
  async run(input, signal) {
    signal?.throwIfAborted();
    if (!localModelReady())
      throw aiProblem(
        503,
        "AI_LOCAL_NOT_READY",
        "本地检索模型未安装，请先运行 npm run ai:setup",
      );
    if (this.busy)
      throw aiProblem(
        429,
        "AI_LOCAL_BUSY",
        "本地检索正在处理其他任务，请稍后重试",
      );
    this.busy = true;
    clearTimeout(this.idle);
    try {
      if (!this.child) {
        this.child = fork(new URL("./local-worker.mjs", import.meta.url), [], {
          windowsHide: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          env: {
            ...process.env,
            AI_LOCAL_MODEL_DIR: modelDirectory(),
            OMP_NUM_THREADS: "1",
            MKL_NUM_THREADS: "1",
          },
          execArgv: [],
        });
        try {
          setPriority(this.child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
        } catch {
          this.child.kill();
          this.child = null;
          throw aiProblem(
            503,
            "AI_PRIORITY_FAILED",
            "无法限制本地模型进程优先级，已停止推理",
          );
        }
      }
      const child = this.child,
        id = ++this.sequence;
      return await new Promise((resolveResult, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          child.off("message", message);
          child.off("exit", exit);
          child.off("error", error);
        };
        const fail = (e) => {
          cleanup();
          if (this.child === child) this.child = null;
          child.kill();
          reject(e);
        };
        const abort = () => fail(signal.reason || new Error("cancelled"));
        const exit = () =>
          fail(aiProblem(503, "AI_LOCAL_EXIT", "本地模型进程已停止"));
        const error = () =>
          fail(aiProblem(503, "AI_LOCAL_EXIT", "本地模型进程启动失败"));
        const message = (result) => {
          if (result.id !== id) return;
          cleanup();
          if (result.error)
            reject(
              aiProblem(
                503,
                "AI_LOCAL_INFERENCE",
                "本地模型推理失败，请检查模型文件及可用内存",
              ),
            );
          else resolveResult(result);
        };
        const timer = setTimeout(
          () =>
            fail(
              aiProblem(
                504,
                "AI_LOCAL_TIMEOUT",
                "本地模型推理超时，已释放进程",
              ),
            ),
          90000,
        );
        signal?.addEventListener("abort", abort, { once: true });
        child.on("message", message);
        child.once("exit", exit);
        child.once("error", error);
        child.send({ ...input, id }, (e) => {
          if (e) error();
        });
        if (signal?.aborted) abort();
      });
    } finally {
      this.busy = false;
      this.idle = setTimeout(() => this.close(), 60000);
      this.idle.unref();
    }
  }
  close() {
    clearTimeout(this.idle);
    this.child?.kill();
    this.child = null;
  }
}

export function cosine(a, b) {
  if (!a?.length || a.length !== b?.length)
    throw new Error("Invalid embedding dimensions");
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i]))
      throw new Error("Invalid embedding");
    dot += a[i] * b[i];
    aa += a[i] ** 2;
    bb += b[i] ** 2;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

// Native Chinese encoder accepts free-form descriptions; no object vocabulary gate.
export function localText(question) {
  const text = String(question)
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length > 500)
    throw aiProblem(400, "INVALID_AI_QUERY", "请输入不超过500字的查询描述");
  return text;
}
