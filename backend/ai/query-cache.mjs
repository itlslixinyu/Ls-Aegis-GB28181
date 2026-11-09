import { createHash } from "node:crypto";
import { LOCAL_VERSION, localText } from "./local-model.mjs";
export const PARSER_VERSION = "native-zh-normalize-chunks40-v1";
export function parseLocalQuery(value) {
  const text = localText(value),
    chars = Array.from(text),
    parts = [];
  for (let i = 0; i < chars.length; i += 40)
    parts.push(chars.slice(i, i + 40).join(""));
  return {
    text,
    parts,
    parser: PARSER_VERSION,
    language: /\p{Script=Han}/u.test(text) ? "zh" : "other",
  };
}
export class QueryCache {
  constructor(db, now = () => Date.now()) {
    this.db = db;
    this.now = now;
  }
  key(owner, key) {
    return createHash("sha256")
      .update(JSON.stringify([owner, key, LOCAL_VERSION, PARSER_VERSION]))
      .digest("hex");
  }
  get(owner, key) {
    const row = this.db
      .prepare(
        "SELECT parsed,embedding FROM ai_query_cache WHERE cacheKey=? AND ownerId=? AND expiresAt>?",
      )
      .get(this.key(owner, key), owner, new Date(this.now()).toISOString());
    if (!row) return null;
    const embedding = JSON.parse(row.embedding);
    if (embedding.length !== 512 || embedding.some((x) => !Number.isFinite(x)))
      return null;
    return { embedding, parsed: JSON.parse(row.parsed) };
  }
  put(owner, key, parsed, embedding, expiresAt) {
    this.db
      .prepare("DELETE FROM ai_query_cache WHERE expiresAt<=?")
      .run(new Date(this.now()).toISOString());
    this.db
      .prepare(
        "DELETE FROM ai_query_cache WHERE cacheKey IN (SELECT cacheKey FROM ai_query_cache ORDER BY expiresAt LIMIT max(0,(SELECT count(*) FROM ai_query_cache)-999))",
      )
      .run();
    this.db
      .prepare("INSERT OR REPLACE INTO ai_query_cache VALUES(?,?,?,?,?)")
      .run(
        this.key(owner, key),
        owner,
        JSON.stringify(parsed),
        JSON.stringify(embedding),
        expiresAt,
      );
  }
}
