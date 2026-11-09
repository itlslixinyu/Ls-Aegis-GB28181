import { test } from "node:test";
import assert from "node:assert/strict";
import {
  archiveStart,
  clockTime,
  followingSegment,
  segmentAt,
} from "../frontend/src/archive-timeline.ts";

test("录像时间轴使用实际文件时刻，拒绝未知格式及非法时间", () => {
  assert.equal(archiveStart("2026-11-07-09-02-03-0.mp4", "2026-11-07"), 32523);
  assert.equal(archiveStart("23-59-58-0.mp4", "2026-11-07"), 86398);
  for (const name of [
    "2026-11-06-09-00-00.mp4",
    "24-00-00.mp4",
    "12-60-00.mp4",
    "file.mp4",
  ])
    assert.equal(archiveStart(name, "2026-11-07"), null);
  assert.equal(clockTime(86400), "24:00:00");
  assert.equal(clockTime(1), "00:00:01");
});
test("按真实时长定位，区分空档，重叠分段不循环，跨午夜保留文件偏移", () => {
  const s = [
    { id: "a", start: -60, end: 60 },
    { id: "b", start: 60, end: 120 },
    { id: "duplicate", start: 60, end: 110 },
    { id: "c", start: 180, end: 240 },
  ];
  assert.equal(segmentAt(s, 0, false).id, "a");
  assert.equal(segmentAt(s, 60, false).id, "b");
  assert.equal(segmentAt(s, 150, false), undefined);
  assert.equal(segmentAt(s, 150, true).id, "c");
  assert.equal(followingSegment(s, s[0]).id, "b");
  assert.equal(followingSegment(s, s[1]).id, "c");
  assert.equal(followingSegment(s, s[3]), undefined);
  assert.equal(segmentAt(s, 86400, true), undefined);
});
