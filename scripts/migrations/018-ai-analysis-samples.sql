CREATE TABLE ai_history_samples(
  id TEXT PRIMARY KEY,
  searchId TEXT NOT NULL REFERENCES ai_history_searches(id) ON DELETE CASCADE,
  fileId TEXT NOT NULL REFERENCES recording_files(id) ON DELETE CASCADE,
  sourceVersion TEXT,
  modelVersion TEXT NOT NULL,
  offset REAL NOT NULL,
  capturedAt TEXT NOT NULL,
  reason TEXT NOT NULL,
  image BLOB NOT NULL,
  imageHash TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  score REAL NOT NULL,
  createdAt TEXT NOT NULL,
  UNIQUE(searchId,fileId,offset)
);
CREATE INDEX ai_history_samples_search ON ai_history_samples(searchId,capturedAt);
CREATE INDEX ai_history_samples_reuse ON ai_history_samples(fileId,sourceVersion,modelVersion,offset);
CREATE TABLE ai_analysis_storage(id INTEGER PRIMARY KEY CHECK(id=1),bytes INTEGER NOT NULL DEFAULT 0);
INSERT INTO ai_analysis_storage VALUES(1,0);
CREATE TRIGGER ai_sample_storage_insert AFTER INSERT ON ai_history_samples BEGIN UPDATE ai_analysis_storage SET bytes=bytes+length(NEW.image)+length(NEW.embedding) WHERE id=1; END;
CREATE TRIGGER ai_sample_storage_delete AFTER DELETE ON ai_history_samples BEGIN UPDATE ai_analysis_storage SET bytes=max(0,bytes-length(OLD.image)-length(OLD.embedding)) WHERE id=1; END;
INSERT INTO migrations VALUES(18);
