// Run: npm run test:unit (Node >= 23 strips the .ts types natively).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkRanges, groupLines, lineAt, defaultMicTrack, costCents, fmtTime } from "./transcript.ts";

const w = (word, start, end) => ({ word: word.toLowerCase().replace(/[.?!,]/g, ""), punctuated_word: word, start, end, confidence: 0.9 });

test("chunkRanges: 2 h recording → 18-min chunks with offsets, short tail folded", () => {
  const r = chunkRanges(7200);
  assert.equal(r[0].start, 0);
  assert.equal(r[1].start, 1080);
  assert.equal(r.at(-1).end, 7200);
  assert.ok(r.every((c) => c.end - c.start >= 60));
  // 18:30 → one chunk, the 30 s tail folds in
  assert.deepEqual(chunkRanges(1110), [{ start: 0, end: 1110 }]);
  assert.deepEqual(chunkRanges(20), [{ start: 0, end: 20 }]);
  assert.deepEqual(chunkRanges(0), []);
});

test("groupLines: breaks on sentence end and on pauses", () => {
  const words = [w("Hello", 0, 0.4), w("there.", 0.5, 0.9), w("This", 1.0, 1.2), w("jump", 1.3, 1.5), w("feels", 4.0, 4.3), w("good", 4.4, 4.7)];
  const lines = groupLines(words);
  assert.deepEqual(lines.map((l) => l.text), ["Hello there.", "This jump", "feels good"]);
  assert.equal(lines[2].start, 4.0);
  assert.equal(lines[2].firstWord, 4);
});

test("lineAt: binary search by start time", () => {
  const lines = [{ start: 0 }, { start: 2 }, { start: 5 }];
  assert.equal(lineAt(lines, -1), -1);
  assert.equal(lineAt(lines, 0), 0);
  assert.equal(lineAt(lines, 4.99), 1);
  assert.equal(lineAt(lines, 99), 2);
});

test("defaultMicTrack: remembered > Track 2 > last", () => {
  assert.equal(defaultMicTrack(2, null), 2);
  assert.equal(defaultMicTrack(3, 3), 3);
  assert.equal(defaultMicTrack(2, 5), 2);
  assert.equal(defaultMicTrack(1, null), 1);
});

test("costCents and fmtTime", () => {
  assert.ok(Math.abs(costCents(900) - 6.45) < 1e-9); // 15 min ≈ 6.45 ¢
  assert.equal(fmtTime(65), "1:05");
  assert.equal(fmtTime(3725), "1:02:05");
});
