// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAN_CAP, DISCORD_CAP, budget, chanClamp, clipFileName, gameTrack, gradientFrom, layout, lengthWarnings,
  outlineColor, planClip, rangeError, retryKbps,
} from "./clip.ts";

test("caps match Clip Sizer's code constants", () => {
  assert.equal(DISCORD_CAP, 19.9e6);
  assert.equal(CHAN_CAP, 4194304);
});

test("budget for a 10 s 720p clip matches Clip Sizer's estimate()", () => {
  // Discord caps the long side at 1080 (Clip Sizer), so 1280×720 → 1080×606.
  // discord: floor((19e6*8/10/1000 - 128) * .94) = floor((15200-128)*.94) = 14167
  // 4chan:   floor(4.09e6*8/10/1000 * .97) = floor(3272*.97) = 3173
  assert.deepEqual(budget(10, 1280, 720), { discordVideo: 14167, chanVideo: 3173, dw: 1080, dh: 606, cw: 1280, ch: 720 });
});

test("long clips drop resolution tiers and hit the bitrate floors", () => {
  const b = budget(60, 1280, 720); // 4chan ~528 kb/s → 720 tier → floored up to 960 long side
  assert.equal(b.chanVideo, 528);
  assert.deepEqual([b.cw, b.ch], [960, 538]);
  const starve = budget(3600, 1280, 720);
  assert.equal(starve.discordVideo, 80);
  assert.equal(starve.chanVideo, 70);
});

test("chanClamp: aim 1280, floor 960 only for big sources, never upscale small ones", () => {
  assert.deepEqual(chanClamp(1920, 1080, 1920, 1080), [1280, 720]);
  assert.deepEqual(chanClamp(480, 270, 1280, 720), [960, 540]);
  assert.deepEqual(chanClamp(480, 270, 640, 360), [480, 270]);
});

test("planClip: Discord + 4chan always, Socials pack on request", () => {
  const base = planClip(10, 1280, 720, false, "fit");
  assert.deepEqual(base.map((j) => [j.id, j.ext, j.codec, j.audio, j.cap]), [
    ["discord", "mp4", "avc", true, DISCORD_CAP],
    ["chan", "webm", "vp9", false, CHAN_CAP],
  ]);
  const all = planClip(10, 1280, 720, true, "gradient");
  assert.deepEqual(all.slice(2).map((j) => [j.file, j.width, j.height, j.kbps, j.cap, j.mode]), [
    ["Horizontal", 1920, 1080, 8000, null, "gradient"],
    ["Vertical", 1080, 1920, 8000, null, "gradient"],
    ["Square", 1080, 1080, 8000, null, "gradient"],
  ]);
  assert.equal(all[0].mode, "fit", "Discord keeps the clip's shape");
});

test("retry scales by cap/size*0.95 with a floor", () => {
  assert.equal(retryKbps(1000, 5e6, 4e6, 70), 760);
  assert.equal(retryKbps(80, 9e6, 4e6, 70), 70);
});

test("layout: fit letterboxes at gaze height on vertical, fill centre-crops", () => {
  const v = layout("fit", 1280, 720, 1080, 1920);
  assert.deepEqual(v.dst, { x: 0, y: 464, w: 1080, h: 608 });
  assert.ok(v.bars);
  const f = layout("fill", 1280, 720, 1080, 1080);
  assert.deepEqual(f.src, { x: 280, y: 0, w: 720, h: 720 });
  assert.equal(layout("fit", 1280, 720, 1920, 1080).bars, false);
});

test("gradient + outline colours", () => {
  assert.deepEqual(gradientFrom([]), ["#0c0d11", "#232733"]);
  assert.deepEqual(gradientFrom([[100, 100, 100], [200, 0, 0], [0, 0, 200]]), ["#2d002d", "#4b004b"]);
  assert.equal(outlineColor(["#000000", "#646464"]), "#939393");
});

test("file names fit the session-folder rule", () => {
  const n = clipFileName(62.5, 80, { file: "Discord", ext: "mp4" });
  assert.equal(n, "clip_1m02.5-1m20.0_Discord.mp4");
  assert.match(n, /^[A-Za-z0-9_.-]{1,64}$/);
  assert.ok(clipFileName(35999, 36000, { file: "Horizontal", ext: "mp4" }).length <= 64);
});

test("range validation, game track and warnings", () => {
  assert.match(rangeError(null, 3, 20), /Mark both/);
  assert.match(rangeError(5, 3, 20), /after In/);
  assert.equal(rangeError(2, 12, 20), null);
  assert.equal(gameTrack(2, 2), 1);
  assert.equal(gameTrack(2, 1), 2);
  assert.equal(gameTrack(1, 1), null);
  assert.equal(lengthWarnings(30, true).length, 0);
  assert.equal(lengthWarnings(150, true).length, 2);
  assert.equal(lengthWarnings(150, false).length, 1);
});
