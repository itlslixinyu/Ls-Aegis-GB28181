import { createHash } from "node:crypto";
import { LOCAL_VERSION } from "./local-model.mjs";
export class FeatureCache {
  constructor(db, now = () => Date.now()) {
    this.db = db;
    this.now = now;
  }
  duration(fileId, version) {
    if (!version) return null;
    return (
      this.db
        .prepare(
          "SELECT duration FROM ai_duration_cache WHERE fileId=? AND sourceVersion=? AND expiresAt>?",
        )
        .get(fileId, version, new Date(this.now()).toISOString())?.duration ??
      null
    );
  }
  saveDuration(fileId, version, duration, expiresAt) {
    if (
      !version ||
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > 86400
    )
      return;
    this.db
      .prepare("DELETE FROM ai_duration_cache WHERE expiresAt<=?")
      .run(new Date(this.now()).toISOString());
    this.db
      .prepare("INSERT OR REPLACE INTO ai_duration_cache VALUES(?,?,?,?)")
      .run(fileId, version, duration, expiresAt);
    this.db
      .prepare(
        "DELETE FROM ai_duration_cache WHERE fileId IN (SELECT fileId FROM ai_duration_cache ORDER BY expiresAt LIMIT max(0,(SELECT count(*) FROM ai_duration_cache)-10000))",
      )
      .run();
  }
  key(fileId, version, offset) {
    return createHash("sha256")
      .update(JSON.stringify([fileId, version, offset, LOCAL_VERSION]))
      .digest("hex");
  }
  get(fileId, version, offset) {
    if (!version) return null;
    const row = this.db
      .prepare(
        "SELECT image,imageInfo,embedding FROM ai_feature_cache WHERE cacheKey=? AND expiresAt>?",
      )
      .get(
        this.key(fileId, version, offset),
        new Date(this.now()).toISOString(),
      );
    if (!row) return null;
    const embedding = JSON.parse(row.embedding);
    if (embedding.length !== 512 || embedding.some((x) => !Number.isFinite(x)))
      return null;
    const info = JSON.parse(row.imageInfo);
    if (
      !Number.isInteger(info.width) ||
      !Number.isInteger(info.height) ||
      info.width < 1 ||
      info.height < 1 ||
      !/^[a-f0-9]{16}$/.test(info.hash || "")
    )
      return null;
    return { image: Buffer.from(row.image), embedding, ...info };
  }
  put(fileId, version, offset, prepared, embedding, expiresAt) {
    const { image, width, height, hash } = prepared;
    if (!version) return;
    this.db
      .prepare("DELETE FROM ai_feature_cache WHERE expiresAt<=?")
      .run(new Date(this.now()).toISOString());
    // Hard quota: 128 MiB and 1,000 sampled frames. Cache eviction cannot delete recordings.
    while (true) {
      const storage = this.db
        .prepare(
          "SELECT count(*) n,coalesce(sum(length(image)+length(embedding)),0) bytes FROM ai_feature_cache",
        )
        .get();
      if (
        storage.n < 1000 &&
        storage.bytes + image.length + 16384 < 128 * 1048576
      )
        break;
      const old = this.db
        .prepare(
          "SELECT cacheKey FROM ai_feature_cache ORDER BY createdAt LIMIT 1",
        )
        .get();
      if (!old) return;
      this.db
        .prepare("DELETE FROM ai_feature_cache WHERE cacheKey=?")
        .run(old.cacheKey);
    }
    this.db
      .prepare(
        "INSERT OR REPLACE INTO ai_feature_cache VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        this.key(fileId, version, offset),
        fileId,
        version,
        LOCAL_VERSION,
        offset,
        image,
        JSON.stringify({ width, height, hash }),
        JSON.stringify(embedding),
        new Date(this.now()).toISOString(),
        expiresAt,
      );
  }
}
