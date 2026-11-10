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

import { TR_META, trProviderOf, localModelOf, canResume, wavToFloat32, wordsFromWhisper } from "./transcript.ts";

test("trProviderOf: known providers pass, anything else is Deepgram", () => {
  for (const p of ["deepgram", "openai", "groq", "local"]) assert.equal(trProviderOf(p), p);
  for (const p of [null, undefined, "", "Groq", "whisper", "openai_compat"]) assert.equal(trProviderOf(p), "deepgram");
  assert.equal(TR_META.deepgram.defaultModel, "nova-3");
  assert.equal(TR_META.deepgram.chunkSeconds, 18 * 60);
  assert.equal(TR_META.local.chunkSeconds, 18 * 60);
  // OpenAI + Groq: 25 MB upload cap → a 16 kHz s16 mono chunk must stay under it.
  for (const p of ["openai", "groq"]) assert.ok(TR_META[p].chunkSeconds * 16000 * 2 + 44 < 25 * 1024 * 1024, p);
});

test("localModelOf: only offered models, else whisper-tiny", () => {
  assert.equal(localModelOf("Xenova/whisper-small"), "Xenova/whisper-small");
  assert.equal(localModelOf(null), "Xenova/whisper-tiny");
  assert.equal(localModelOf("nova-3"), "Xenova/whisper-tiny");
});

test("canResume: same provider + model + track only; legacy files are Deepgram", () => {
  const legacy = { model: "nova-3", chunks: [{}] };
  assert.equal(canResume(legacy, 2, "deepgram", "nova-3", 2), true);
  assert.equal(canResume(legacy, 2, "groq", "nova-3", 2), false);
  assert.equal(canResume(legacy, 2, "deepgram", "nova-2", 2), false);
  assert.equal(canResume(legacy, 2, "deepgram", "nova-3", 1), false);
  assert.equal(canResume({ ...legacy, chunks: [] }, 2, "deepgram", "nova-3", 2), false);
  assert.equal(canResume(null, 2, "deepgram", "nova-3", 2), false);
  const g = { provider: "groq", model: "whisper-large-v3-turbo", chunks: [{}] };
  assert.equal(canResume(g, 2, "groq", "whisper-large-v3-turbo", 2), true);
  assert.equal(canResume(g, 2, "openai", "whisper-large-v3-turbo", 2), false);
});

function wav(samples, rate = 16000, channels = 1, dataSize) {
  const b = new ArrayBuffer(44 + samples.length * 2), v = new DataView(b);
  const s = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  s(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); s(8, "WAVE");
  s(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * channels * 2, true); v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
  s(36, "data"); v.setUint32(40, dataSize ?? samples.length * 2, true);
  samples.forEach((x, i) => v.setInt16(44 + i * 2, x, true));
  return b;
}

test("wavToFloat32: s16 mono/stereo, placeholder sizes, rejects junk", () => {
  const m = wavToFloat32(wav([0, 16384, -32768, 32767]));
  assert.equal(m.sampleRate, 16000);
  assert.deepEqual([...m.samples], [0, 0.5, -1, 32767 / 32768]);
  const st = wavToFloat32(wav([16384, 0, -16384, -16384], 48000, 2));
  assert.deepEqual([...st.samples], [0.25, -0.5]);
  assert.equal(st.sampleRate, 48000);
  assert.equal(wavToFloat32(wav([1, 2, 3], 16000, 1, 0xffffffff)).samples.length, 3);
  assert.equal(wavToFloat32(wav([1, 2, 3], 16000, 1, 0)).samples.length, 3);
  assert.throws(() => wavToFloat32(new ArrayBuffer(8)));
  assert.throws(() => wavToFloat32(new TextEncoder().encode("RIFF____WAVEjunk").buffer));
});

test("wordsFromWhisper: Deepgram word shape, offset, null timestamps", () => {
  const w = wordsFromWhisper([
    { text: " Okay,", timestamp: [0.08, 0.48] },
    { text: " the", timestamp: [0.64, 0.8] },
    { text: " floaty.", timestamp: [1.44, null] },
    { text: " lost", timestamp: [null, 2] },
    { text: " ", timestamp: [2, 2.1] },
    { text: " don't", timestamp: [2.1, 2.4] },
  ], 1080);
  assert.deepEqual(w.map((x) => x.punctuated_word), ["Okay,", "the", "floaty.", "don't"]);
  assert.deepEqual(w.map((x) => x.word), ["okay", "the", "floaty", "don't"]);
  assert.ok(Math.abs(w[0].start - 1080.08) < 1e-9 && Math.abs(w[0].end - 1080.48) < 1e-9);
  assert.equal(w[2].end, w[2].start); // missing end borrows start
  assert.deepEqual(Object.keys(w[0]).sort(), ["confidence", "end", "punctuated_word", "start", "word"]);
});
