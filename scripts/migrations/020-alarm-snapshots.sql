CREATE TABLE alarm_snapshots(id TEXT PRIMARY KEY,status TEXT NOT NULL,error TEXT,requestedAt TEXT NOT NULL,capturedAt TEXT,image BLOB);
CREATE TABLE alarm_snapshot_links(alarmId TEXT PRIMARY KEY REFERENCES alarms(id) ON DELETE CASCADE,snapshotId TEXT REFERENCES alarm_snapshots(id) ON DELETE SET NULL);
INSERT INTO migrations VALUES(20);
