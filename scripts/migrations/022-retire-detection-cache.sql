-- Retire derived detections only; analysis records, images and recordings remain intact.
DROP TABLE IF EXISTS ai_detection_cache;
INSERT INTO migrations VALUES(22);
