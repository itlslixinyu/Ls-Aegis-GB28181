ALTER TABLE ai_jobs ADD COLUMN recordingFileId TEXT REFERENCES recording_files(id) ON DELETE CASCADE;
ALTER TABLE ai_jobs ADD COLUMN frameOffset REAL;
CREATE INDEX idx_ai_jobs_recording_file ON ai_jobs(recordingFileId,frameOffset);
CREATE TABLE ai_history_searches(id TEXT PRIMARY KEY,ownerId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,requestKey TEXT NOT NULL,requestHash TEXT NOT NULL,params TEXT NOT NULL,status TEXT NOT NULL,phase TEXT NOT NULL DEFAULT 'queued',fileCount INTEGER NOT NULL DEFAULT 0,candidateFiles INTEGER NOT NULL DEFAULT 0,sampleCount INTEGER NOT NULL DEFAULT 0,modelCalls INTEGER NOT NULL DEFAULT 0,truncated INTEGER NOT NULL DEFAULT 0,error TEXT,createdAt TEXT NOT NULL,finishedAt TEXT,expiresAt TEXT NOT NULL,UNIQUE(ownerId,requestKey));
CREATE INDEX idx_ai_history_search_status ON ai_history_searches(status,createdAt);
CREATE TABLE ai_history_matches(searchId TEXT NOT NULL REFERENCES ai_history_searches(id) ON DELETE CASCADE,analysisId TEXT NOT NULL REFERENCES ai_jobs(id) ON DELETE CASCADE,PRIMARY KEY(searchId,analysisId));
INSERT INTO migrations VALUES(15);
