CREATE TABLE ai_motion_cache(
  cacheKey TEXT PRIMARY KEY,
  fileId TEXT NOT NULL REFERENCES recording_files(id) ON DELETE CASCADE,
  output TEXT NOT NULL,
  expiresAt TEXT NOT NULL
);
CREATE INDEX ai_motion_expiry ON ai_motion_cache(expiresAt);
CREATE TABLE ai_query_cache(
  cacheKey TEXT PRIMARY KEY,
  ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parsed TEXT NOT NULL,
  embedding TEXT NOT NULL,
  expiresAt TEXT NOT NULL
);
CREATE INDEX ai_query_expiry ON ai_query_cache(expiresAt);
INSERT INTO migrations VALUES(17);
