-- Existing channel plans and their job IDs remain unchanged.
CREATE TABLE recording_plan_groups(
  id TEXT PRIMARY KEY,
  deviceGroupId TEXT REFERENCES device_groups(id) ON DELETE SET NULL,
  ownerId TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  requestKey TEXT,
  requestHash TEXT,
  createdAt TEXT NOT NULL,
  UNIQUE(ownerId,requestKey)
);
CREATE TABLE recording_plan_members(
  groupPlanId TEXT NOT NULL REFERENCES recording_plan_groups(id) ON DELETE CASCADE,
  planId TEXT NOT NULL UNIQUE REFERENCES recording_plans(id) ON DELETE CASCADE,
  PRIMARY KEY(groupPlanId,planId)
);
CREATE INDEX idx_recording_jobs_plan_created ON recording_jobs(planId,createdAt);
INSERT INTO migrations VALUES(13);
