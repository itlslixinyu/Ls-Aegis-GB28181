CREATE TABLE ai_feature_cache(
  cacheKey TEXT PRIMARY KEY,
  fileId TEXT NOT NULL REFERENCES recording_files(id) ON DELETE CASCADE,
  sourceVersion TEXT NOT NULL,
  modelVersion TEXT NOT NULL,
  offset REAL NOT NULL,
  image BLOB NOT NULL,
  imageInfo TEXT NOT NULL,
  embedding TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL
);
CREATE INDEX ai_feature_cache_expiry ON ai_feature_cache(expiresAt);
CREATE TABLE ai_duration_cache(
  fileId TEXT PRIMARY KEY REFERENCES recording_files(id) ON DELETE CASCADE,
  sourceVersion TEXT NOT NULL,
  duration REAL NOT NULL CHECK(duration>0 AND duration<=86400),
  expiresAt TEXT NOT NULL
);
CREATE TABLE ai_verification_cache(
  cacheKey TEXT PRIMARY KEY,
  ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  output TEXT NOT NULL,
  expiresAt TEXT NOT NULL
);
ALTER TABLE ai_history_searches ADD COLUMN localMetrics TEXT NOT NULL DEFAULT '{}';
INSERT INTO migrations VALUES(16);
