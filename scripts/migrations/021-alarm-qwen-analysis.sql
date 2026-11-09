CREATE TABLE alarm_ai_jobs(
 snapshotId TEXT PRIMARY KEY,
 jobId TEXT UNIQUE REFERENCES ai_jobs(id) ON DELETE SET NULL,
 deviceId TEXT NOT NULL,
 channelId TEXT NOT NULL,
 alarmId TEXT NOT NULL,
 queuedAt TEXT NOT NULL,
 capturedAt TEXT NOT NULL,
 startedAt TEXT,
 nextAttempt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX alarm_ai_channel_time ON alarm_ai_jobs(channelId,capturedAt);
INSERT INTO migrations VALUES(21);
