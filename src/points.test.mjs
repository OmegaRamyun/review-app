// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FULL_BUCKETS, RAPID_BUCKETS, bucketsFor, bucketLabel, emptyPoints, parsePoints, newPoint,
  updatePoint, deletePoint, filterPoints, pinnedTimes, shotName,
} from "./points.ts";

test("bucket lists match DESIGN.md exactly", () => {
  assert.deepEqual(FULL_BUCKETS.map((b) => b.label), [
    "Overview/Hook", "Character", "Controls", "Camera", "Game Feel/Juice", "Gameplay Systems",
    "Level Design/Difficulty/Pacing", "Graphical Presentation", "Audio Presentation", "Story/Writing",
    "Performance/Technical", "Length/Value/Replay", "Context", "Verdict",
  ]);
  assert.deepEqual(RAPID_BUCKETS.map((b) => b.label), [
    "Overview", "Feel (3Cs + juice)", "Systems", "Graphics", "Audio", "Verdict",
  ]);
  const ids = [...FULL_BUCKETS, ...RAPID_BUCKETS].map((b) => b.id);
  assert.equal(new Set(ids).size, 20, "ids unique across modes");
  assert.equal(bucketsFor("rapid"), RAPID_BUCKETS);
  assert.equal(bucketsFor("full"), FULL_BUCKETS);
  assert.equal(bucketLabel("camera"), "Camera");
  assert.equal(bucketLabel("rapid-feel"), "Feel (3Cs + juice) (rapid)");
});

const base = (bucket, time) => ({ bucket, quote: "the jump is floaty", time, text: "", screenshot: null, shot_time: null });

test("create / edit / delete keep creation order; ids are never reused", () => {
  const f = emptyPoints();
  const a = newPoint(f, base("controls", 12.5));
  const b = newPoint(f, base("camera", 3));
  assert.deepEqual([a.id, a.order, b.id, b.order], ["p0001", 1, "p0002", 2]);
  updatePoint(f, a.id, { text: "jump arc too floaty", bucket: "feel" });
  assert.equal(f.points[0].text, "jump arc too floaty");
  assert.equal(f.points[0].order, 1);
  assert.equal(deletePoint(f, a.id)?.id, "p0001");
  assert.equal(deletePoint(f, "nope"), null);
  const c = newPoint(f, base("verdict", 99));
  assert.equal(c.id, "p0003");
});

test("filter by bucket, sorted by creation order; pinned lines by start time", () => {
  const f = emptyPoints();
  newPoint(f, base("audio", 50));
  newPoint(f, base("camera", 10));
  newPoint(f, base("audio", 5));
  assert.deepEqual(filterPoints(f.points, "audio").map((p) => p.order), [1, 3]);
  assert.deepEqual(filterPoints([...f.points].reverse(), "").map((p) => p.order), [1, 2, 3]);
  assert.deepEqual([...pinnedTimes(f.points)].sort((x, y) => x - y), [5, 10, 50]);
});

test("parsePoints round-trips and survives missing/damaged files", () => {
  const f = emptyPoints();
  newPoint(f, base("context", 1));
  const back = parsePoints(JSON.stringify(f));
  assert.deepEqual(back, f);
  assert.deepEqual(parsePoints(null), emptyPoints());
  const bad = parsePoints(JSON.stringify({ next: 1, points: [{ id: "p0009", bucket: "x", time: 1, order: 9 }, { junk: 1 }] }));
  assert.equal(bad.points.length, 1);
  assert.equal(bad.next, 10, "next never collides with a stored order");
});

test("shotName is a valid session file name", () => {
  const n = shotName("p0007", 1762600000000);
  assert.equal(n, "shot-p0007-1762600000000.jpg");
  assert.match(n, /^[A-Za-z0-9_.-]{1,64}$/);
});
