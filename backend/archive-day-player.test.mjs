import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";
import { parse } from "vue/compiler-sfc";
import ts from "typescript";
import * as vue from "vue";
import * as timeline from "../frontend/src/archive-timeline.ts";

const settle = async () => {
  for (let n = 0; n < 8; n++) {
    await Promise.resolve();
    await vue.nextTick();
  }
};
function fixture(t, files, durations) {
  const probes = [],
    hooks = [],
    scope = vue.effectScope();
  const original = globalThis.document;
  globalThis.document = {
    createElement: () => {
      const p = {
        duration: 0,
        load() {},
        removeAttribute() {
          this.src = "";
        },
        set src(url) {
          this._src = url;
          if (url && durations[url] !== undefined) {
            this.duration = durations[url];
            queueMicrotask(() => this.onloadedmetadata?.());
          }
        },
        get src() {
          return this._src;
        },
      };
      probes.push(p);
      return p;
    },
  };
  const source = parse(
    readFileSync(
      new URL(
        "../frontend/src/components/ArchiveDayPlayer.vue",
        import.meta.url,
      ),
      "utf8",
    ),
  ).descriptor.scriptSetup.content;
  const code = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const props = vue.reactive({
    channelId: "test",
    channelName: "测试",
    date: "2026-11-07",
    files,
  });
  const state = scope.run(() =>
    compileFunction(
      code +
        ";return {video,segments,current,cursor,seekText,editingTime,seekInput,skipGaps,notice,playing,failed,indexing,seek,loaded,ended,timeUpdate,releasePlayer};",
      ["require", "exports", "defineProps"],
    )(
      (name) => {
        if (name === "vue")
          return { ...vue, onUnmounted: (fn) => hooks.push(fn) };
        if (name === "../remember-filter")
          return { rememberFilter: (_key, value) => vue.ref(value) };
        if (name === "../api") return { can: () => true };
        if (name === "../archive-timeline") return timeline;
        throw Error(name);
      },
      {},
      () => props,
    ),
  );
  const player = {
    readyState: 1,
    currentTime: 0,
    playbackRate: 1,
    ended: false,
    src: "",
    plays: 0,
    load() {},
    pause() {},
    removeAttribute() {
      this.src = "";
    },
    async play() {
      this.plays++;
    },
  };
  state.video.value = player;
  t.after(() => {
    hooks.forEach((fn) => fn());
    scope.stop();
    globalThis.document = original;
  });
  return { state, player, props, probes, hooks };
}
test("全天回放元数据使用实际时长，自动接续、空档停止与跳过均可用", async (t) => {
  const { state: s, player } = fixture(
    t,
    [
      { id: "a", name: "00-00-00-0.mp4", date: "2026-11-07", url: "a" },
      { id: "b", name: "00-00-05-0.mp4", date: "2026-11-07", url: "b" },
      { id: "c", name: "00-00-20-0.mp4", date: "2026-11-07", url: "c" },
    ],
    { a: 5, b: 5, c: 8 },
  );
  await settle();
  assert.deepEqual(
    s.segments.value.map((x) => [x.start, x.end]),
    [
      [0, 5],
      [5, 10],
      [20, 28],
    ],
  );
  assert.equal(player.plays, 0, "读取元数据不自动播放");
  s.seek(3);
  s.loaded();
  await settle();
  assert.equal(player.currentTime, 3);
  assert.equal(s.current.value.id, "a");
  s.editingTime.value = true;
  s.seekText.value = "00:00:04";
  player.currentTime = 3.8;
  s.timeUpdate();
  assert.equal(s.seekText.value, "00:00:04", "定位输入不会被播放进度覆盖");
  s.seekInput();
  assert.equal(player.currentTime, 4);
  s.ended();
  assert.equal(s.current.value.id, "b");
  s.skipGaps.value = false;
  s.ended();
  assert.equal(s.current.value.id, "b");
  assert.match(s.notice.value, /空档/);
  s.skipGaps.value = true;
  s.ended();
  assert.equal(s.current.value.id, "c");
  assert.match(s.notice.value, /跳过/);
  s.seek(30);
  assert.equal(s.current.value, null);
  assert.match(s.notice.value, /没有/);
});

test("无法读取真实时长的文件不伪造录像覆盖，未知文件名明确失败", async (t) => {
  const { state: s } = fixture(
    t,
    [
      { id: "invalid", name: "file.mp4", date: "2026-11-07", url: "invalid" },
      {
        id: "duration",
        name: "09-00-00-0.mp4",
        date: "2026-11-07",
        url: "duration",
      },
    ],
    { duration: Infinity },
  );
  await settle();
  assert.equal(s.segments.value.length, 0);
  assert.equal(s.failed.value, 2);
  assert.equal(s.indexing.value, false);
});
test("跨午夜从前日文件偏移播放，切换文件会取消迟到读取，离开卸载媒体", async (t) => {
  const {
    state: s,
    player,
    props,
    probes,
    hooks,
  } = fixture(
    t,
    [
      {
        id: "previous",
        name: "23-59-00-0.mp4",
        date: "2026-11-06",
        url: "previous",
      },
    ],
    { previous: 120 },
  );
  await settle();
  s.seek(10);
  s.loaded();
  assert.equal(player.currentTime, 70);
  assert.equal(s.segments.value[0].start, -60);
  props.files = [
    { id: "slow", name: "01-00-00-0.mp4", date: "2026-11-07", url: "slow" },
  ];
  await settle();
  const slow = probes.at(-1);
  assert.ok(slow.onloadedmetadata);
  props.files = [];
  await settle();
  assert.equal(slow.onloadedmetadata, null);
  assert.equal(s.segments.value.length, 0);
  assert.equal(s.current.value, null);
  hooks.forEach((fn) => fn());
  assert.equal(player.src, "");
});
