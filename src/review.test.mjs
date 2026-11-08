// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// review.ts imports "./points" extensionless (bundler style); let node resolve it to the .ts file.
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
const R = await import("./review.ts");
const { emptyPoints, newPoint } = await import("./points.ts");

function fixture() {
  const pts = emptyPoints();
  newPoint(pts, { bucket: "controls", quote: "the jump feels floaty", time: 75, text: "Jump is floaty", screenshot: "shot-p0001-1.jpg", shot_time: 76 });
  newPoint(pts, { bucket: "overview", quote: "okay so this is", time: 3, text: "Hook: <grapple> & dash", screenshot: null, shot_time: null });
  newPoint(pts, { bucket: "rapid-feel", quote: "", time: 40, text: "Feels snappy", screenshot: null, shot_time: null });
  newPoint(pts, { bucket: "controls", quote: "", time: 20, text: "Rebindable", screenshot: null, shot_time: null });
  return pts.points;
}

test("sections: buckets with points, mode order first, other-mode buckets after", () => {
  const pts = fixture();
  assert.deepEqual(R.sectionBuckets("full", pts), ["overview", "controls", "rapid-feel"]);
  assert.deepEqual(R.sectionBuckets("rapid", pts), ["rapid-feel", "overview", "controls"]);
  assert.deepEqual(R.pointsIn(pts, "controls").map((p) => p.time), [20, 75]);
});

test("review.json round-trip + damage tolerance", () => {
  const r = R.emptyReview();
  r.verdict = "Worth a wishlist";
  r.sections.controls = { prose: "x", draft: true };
  assert.deepEqual(R.parseReview(JSON.stringify(r)), r);
  assert.deepEqual(R.parseReview(null), R.emptyReview());
  const bad = R.parseReview('{"verdict":5,"sections":{"a":null,"b":{"prose":"p"}},"publish_state":"nope"}');
  assert.equal(bad.verdict, "");
  assert.deepEqual(bad.sections, { b: { prose: "p", draft: false } });
  assert.equal(bad.publish_state, "draft");
});

test("draft prompt carries notes per bucket and never asks for a score", () => {
  const pts = fixture();
  const p = R.draftPrompt({ title: "Hookshot", mode: "rapid", verdict: "Promising", who_for: "platformer fans", points: pts }, ["overview", "controls"]);
  assert.match(p, /Game: Hookshot/);
  assert.match(p, /## controls — Controls\n- \[0:20\] Rebindable\n- \[1:15\] Jump is floaty \(said while playing: "the jump feels floaty"\)/);
  assert.doesNotMatch(p, /rapid-feel/);
  assert.match(p, /demo-day/);
  assert.match(R.DRAFT_SYSTEM, /Do not give scores/);
});

test("parseDraft: fences, unknown buckets dropped, garbage rejected", () => {
  const out = R.parseDraft('```json\n{"sections":{"controls":" Floaty. ","evil":"x","overview":""}}\n```', ["controls", "overview"]);
  assert.deepEqual(out, { controls: "Floaty." });
  assert.throws(() => R.parseDraft("sure! here you go", ["controls"]), /not JSON/);
  assert.throws(() => R.parseDraft('{"text":"hi"}', ["controls"]), /sections/);
});

test("applyDraft never overwrites the user's own prose", () => {
  const r = R.emptyReview();
  r.sections.controls = { prose: "Mine.", draft: false };
  r.sections.overview = { prose: "Old draft", draft: true };
  const res = R.applyDraft(r, { controls: "AI", overview: "New draft", camera: "AI cam" });
  assert.deepEqual(res, { filled: ["overview", "camera"], kept: ["controls"] });
  assert.deepEqual(r.sections.controls, { prose: "Mine.", draft: false });
  assert.deepEqual(r.sections.camera, { prose: "AI cam", draft: true });
  assert.deepEqual(R.unreviewedDrafts(r, ["controls", "overview"]), ["overview"]);
});

test("page: escaped, numbered, draft-marked, no score in rapid mode", () => {
  const pts = fixture();
  const review = R.emptyReview();
  review.score = "7/10";
  review.verdict = "Play it";
  review.sections.controls = { prose: "Para one.\n\nPara <two>.", draft: true };
  const input = { title: "Hookshot", mode: "full", review, points: pts, shotUrl: (n) => `shots/${n}`, date: "2026-11-08T20:00:00Z" };
  const full = R.renderPage(input);
  assert.match(full, /\[01\]<\/span> Overview\/Hook/);
  assert.match(full, /\[02\]<\/span> Controls/);
  assert.match(full, /\[04\]<\/span> Final word/);
  assert.match(full, /Hook: &lt;grapple&gt; &amp; dash/);
  assert.doesNotMatch(full, /<grapple>/);
  assert.match(full, /<p>Para one\.<\/p>\n<p>Para &lt;two&gt;\.<\/p>/);
  assert.match(full, /class="prose draft"/);
  assert.match(full, /src="shots\/shot-p0001-1\.jpg"/);
  assert.match(full, /class="score">7\/10/);
  assert.doesNotMatch(full, /<script/i);
  const rapid = R.renderPage({ ...input, mode: "rapid" });
  assert.doesNotMatch(rapid, /7\/10/);
  assert.doesNotMatch(rapid, /Score/);
  assert.match(rapid, /DEMO-DAY QUICK TAKE/);
});

test("ascii banner fits its box", () => {
  const b = R.asciiBanner("The Extraordinarily Long Title Of A Game That Wraps", 30).split("\n");
  assert.ok(b.every((l) => l.length === 30), b.join("\n"));
  assert.equal(b[0], `+${"=".repeat(28)}+`);
  assert.equal(R.fmtStamp(3725), "1:02:05");
  assert.equal(R.fmtStamp(75), "1:15");
});
