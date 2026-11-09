CREATE TABLE ai_jobs(
  id TEXT PRIMARY KEY,
  ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channelId TEXT,
  sourceName TEXT NOT NULL,
  sourceType TEXT NOT NULL CHECK(sourceType IN ('upload','channel','image-search','text-search')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled','interrupted')),
  question TEXT NOT NULL,
  requestKey TEXT,
  requestHash TEXT,
  image BLOB,
  imageHash TEXT,
  width INTEGER,
  height INTEGER,
  result TEXT,
  model TEXT,
  usage TEXT,
  error TEXT,
  createdAt TEXT NOT NULL,
  capturedAt TEXT,
  finishedAt TEXT,
  expiresAt TEXT NOT NULL,
  UNIQUE(ownerId,requestKey)
);
CREATE INDEX idx_ai_jobs_owner_time ON ai_jobs(ownerId,createdAt);
CREATE INDEX idx_ai_jobs_channel_time ON ai_jobs(channelId,createdAt);
CREATE INDEX idx_ai_jobs_status ON ai_jobs(status,createdAt);
CREATE INDEX idx_ai_jobs_expiry ON ai_jobs(expiresAt);
INSERT INTO migrations VALUES(14);
