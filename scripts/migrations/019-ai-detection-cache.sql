CREATE TABLE ai_detection_cache(cacheKey TEXT PRIMARY KEY,result TEXT NOT NULL,expiresAt TEXT NOT NULL);
CREATE INDEX ai_detection_cache_expiry ON ai_detection_cache(expiresAt);
INSERT INTO migrations VALUES(19);
