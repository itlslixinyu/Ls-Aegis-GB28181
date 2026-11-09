CREATE TABLE ai_index_files(
 fileId TEXT PRIMARY KEY REFERENCES recording_files(id) ON DELETE CASCADE,
 sourceVersion TEXT NOT NULL, modelVersion TEXT NOT NULL,
 duration REAL NOT NULL, nextOffset REAL NOT NULL DEFAULT 0,
 pendingOffsets TEXT NOT NULL DEFAULT '[]', scanEnd REAL NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'pending', updatedAt INTEGER NOT NULL,
 expiresAt INTEGER NOT NULL, retryAt INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE ai_index_frames(
 fileId TEXT NOT NULL REFERENCES ai_index_files(fileId) ON DELETE CASCADE,
 offset REAL NOT NULL, image BLOB NOT NULL, imageHash TEXT NOT NULL,
 width INTEGER NOT NULL,height INTEGER NOT NULL,embedding BLOB NOT NULL,
 PRIMARY KEY(fileId,offset)
);
CREATE TABLE ai_index_storage(id INTEGER PRIMARY KEY CHECK(id=1),bytes INTEGER NOT NULL DEFAULT 0);
INSERT INTO ai_index_storage VALUES(1,0);
CREATE TRIGGER ai_index_insert AFTER INSERT ON ai_index_frames BEGIN UPDATE ai_index_storage SET bytes=bytes+length(NEW.image)+length(NEW.embedding)+128 WHERE id=1; END;
CREATE TRIGGER ai_index_delete AFTER DELETE ON ai_index_frames BEGIN UPDATE ai_index_storage SET bytes=max(0,bytes-length(OLD.image)-length(OLD.embedding)-128) WHERE id=1; END;
CREATE INDEX ai_index_expiry ON ai_index_files(expiresAt);
INSERT INTO migrations VALUES(23);
