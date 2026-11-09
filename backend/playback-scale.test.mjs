import { test } from "node:test";
import assert from "node:assert/strict";
import { validPlaybackScale } from "./lib/playback-scale.mjs";
test("设备倍速只接受有限受控数值，保留旧慢放并支持有符号高速", () => {
  for (const rate of [0.25, 0.5, 1, 2, 4, 8, 16, -1, -2, -4, -8, -16])
    assert.equal(validPlaybackScale(rate), true);
  for (const rate of [0, 3, 32, -0.5, Infinity, NaN, "16", null, undefined])
    assert.equal(validPlaybackScale(rate), false);
});
