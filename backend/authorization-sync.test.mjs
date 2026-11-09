import test from "node:test";
import assert from "node:assert/strict";
import { setSession, currentUser } from "../frontend/src/api.ts";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
const source = readFileSync(
  new URL("../frontend/src/authorization-sync.ts", import.meta.url),
  "utf8",
).replace(
  '"./api"',
  JSON.stringify(new URL("../frontend/src/api.ts", import.meta.url).href),
);
const { connectAuthorizationUpdates } = await import(
  "data:text/javascript;base64," +
    Buffer.from(stripTypeScriptTypes(source)).toString("base64")
);
const pause = () => new Promise((r) => setImmediate(r));
test("通知期间的并发变更重新取快照；清理后迟到事件不更新新账号", async (t) => {
  let source,
    calls = 0,
    complete;
  class FakeEvents extends EventTarget {
    constructor() {
      super();
      source = this;
    }
    close() {
      this.closed = true;
    }
  }
  const original = globalThis.EventSource;
  globalThis.EventSource = FakeEvents;
  t.after(() => {
    if (original === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = original;
  });
  setSession({
    user: { id: "test", role: "viewer", username: "test" },
    csrf: "test",
  });
  t.mock.method(globalThis, "fetch", () => {
    calls++;
    return new Promise((r) => (complete = r));
  });
  let changed = 0;
  const stop = connectAuthorizationUpdates(() => changed++);
  t.after(stop);
  source.dispatchEvent(new Event("authorization"));
  source.dispatchEvent(new Event("authorization"));
  complete(
    Response.json({
      data: {
        user: { id: "test", role: "viewer", username: "test" },
        csrf: "test",
      },
    }),
  );
  await pause();
  assert.equal(calls, 2);
  assert.equal(changed, 0);
  complete(
    Response.json({
      data: {
        user: { id: "test", role: "viewer", username: "test", permissions: [] },
        csrf: "test",
      },
    }),
  );
  await pause();
  assert.equal(changed, 1);
  assert.deepEqual(currentUser.value.permissions, []);
  source.dispatchEvent(new Event("authorization"));
  stop();
  setSession({
    user: { id: "next", role: "viewer", username: "next" },
    csrf: "next",
  });
  complete(
    Response.json({
      data: {
        user: { id: "test", role: "viewer", username: "test" },
        csrf: "test",
      },
    }),
  );
  await pause();
  assert.equal(changed, 1);
  assert.equal(currentUser.value.id, "next");
  assert.equal(source.closed, true);
  const before = calls;
  source.dispatchEvent(new Event("authorization"));
  source.dispatchEvent(new Event("expired"));
  await pause();
  assert.equal(calls, before);
});
