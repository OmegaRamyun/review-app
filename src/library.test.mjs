// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith(".") && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
});

const L = await import("./library.ts");

const sess = (o = {}) => JSON.stringify({ id: "x", title: "Hookshot", recording_path: "C:\\v\\a.mkv", date: "2026-11-08T10:00:00Z", mode: "full", mic_track: 2, ...o });
const pts = (buckets) => JSON.stringify({ version: 1, next: buckets.length + 1, points: buckets.map((b, i) => ({ id: `p${i}`, bucket: b, quote: "q", time: i, text: "t", screenshot: null, shot_time: null, order: i + 1 })) });
const rev = (o = {}) => JSON.stringify({ version: 1, verdict: "", who_for: "", score: "", sections: {}, publish_state: "draft", slug: "", url: "", itch_comment: "", ...o });
const sum = (o = {}) => ({ id: "s1", session: sess(), points: null, review: null, transcribed: false, partial_transcript: false, recording_exists: true, ...o });

test("parseSession fills pre-U5 fields", () => {
  const s = L.parseSession(sess(), "fallback");
  assert.equal(s.event, "");
  assert.equal(s.duration, 0);
  assert.equal(L.parseSession(sess({ event: "Demo Day", duration: 912.5, mode: "rapid" }), "x").event, "Demo Day");
  assert.equal(L.parseSession(JSON.stringify({}), "fallback").id, "fallback");
  assert.throws(() => L.parseSession("nope", "x"));
});

test("status ladder", () => {
  const st = (o) => L.deriveStatus(sum(o), "full").status;
  assert.equal(st({}), "imported");
  assert.equal(st({ transcribed: true }), "transcribed");
  assert.equal(st({ transcribed: true, points: pts(["controls"]) }), "points pinned");
  // prose + verdict on every section, no draft → done
  assert.equal(st({ points: pts(["controls"]), review: rev({ verdict: "Yes", sections: { controls: { prose: "Tight.", draft: false } } }) }), "review done");
  // unsigned AI draft holds it back
  assert.equal(st({ points: pts(["controls"]), review: rev({ verdict: "Yes", sections: { controls: { prose: "Tight.", draft: true } } }) }), "points pinned");
  // a section without prose holds it back
  assert.equal(st({ points: pts(["controls", "camera"]), review: rev({ verdict: "Yes", sections: { controls: { prose: "x", draft: false } } }) }), "points pinned");
  assert.equal(st({ review: rev({ publish_state: "exported" }) }), "review done");
  assert.equal(st({ review: rev({ publish_state: "published" }) }), "published");
  assert.equal(st({ transcribed: true, points: "garbage", review: "garbage" }), "transcribed");
  assert.equal(L.deriveStatus(sum({ points: pts(["a", "b"]) }), "full").points, 2);
});

test("rows: newest first, broken session.json dropped, folder name is the id", () => {
  const rows = L.toRows([
    sum({ id: "old", session: sess({ date: "2026-01-01T00:00:00Z" }) }),
    sum({ id: "bad", session: "{" }),
    sum({ id: "new", session: sess({ id: "other", date: "2026-11-01T00:00:00Z" }) }),
  ]);
  assert.deepEqual(rows.map((r) => r.session.id), ["new", "old"]);
});

test("search by game and event, all terms", () => {
  const rows = L.toRows([
    sum({ id: "a", session: sess({ title: "Hookshot Hero", event: "Demo Day Nov" }) }),
    sum({ id: "b", session: sess({ title: "Moss Garden", event: "Jam 12" }) }),
  ]);
  assert.deepEqual(L.searchRows(rows, "hook").map((r) => r.session.id), ["a"]);
  assert.deepEqual(L.searchRows(rows, "jam").map((r) => r.session.id), ["b"]);
  assert.deepEqual(L.searchRows(rows, "demo hero").map((r) => r.session.id), ["a"]);
  assert.deepEqual(L.searchRows(rows, "demo moss"), []);
  assert.equal(L.searchRows(rows, "  ").length, 2);
});

test("queue: enqueue dedupes, prune, next unfinished in order with wrap", () => {
  assert.deepEqual(L.enqueue(["a"], ["b", "a", "b", "c"]), ["a", "b", "c"]);
  assert.deepEqual(L.parseQueue('["a","a",3,"b"]'), ["a", "b"]);
  assert.deepEqual(L.parseQueue("{bad"), []);
  assert.deepEqual(L.pruneQueue(["a", "b", "c"], new Set(["a", "c"])), ["a", "c"]);
  const status = { a: "published", b: "points pinned", c: "imported", d: "review done" };
  const of = (id) => status[id];
  const q = ["a", "b", "c", "d"];
  assert.equal(L.nextInQueue(q, of, null), "b");
  assert.equal(L.nextInQueue(q, of, "b"), "c");
  assert.equal(L.nextInQueue(q, of, "c"), "b"); // wraps to the skipped one
  assert.equal(L.nextInQueue(["a", "d"], of, null), null);
  assert.equal(L.nextInQueue(q, of, "zz"), "b");
});

test("session ids are valid and unique", () => {
  const now = new Date("2026-11-08T21:05:09Z");
  const id = L.newSessionId("D:\\OBS\\My Game (demo).mkv", now);
  assert.equal(id, "20261108-210509-My-Game-demo-");
  assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(L.newSessionId("/v/My Game (demo).mkv", now, new Set([id])), `${id}-2`);
  const long = L.newSessionId(`/v/${"x".repeat(100)}.mkv`, now, new Set([L.newSessionId(`/v/${"x".repeat(100)}.mkv`, now)]));
  assert.ok(long.length <= 64 && long.endsWith("-2"));
  assert.equal(L.fileStem("C:\\a\\b.c.mkv"), "b.c");
});
