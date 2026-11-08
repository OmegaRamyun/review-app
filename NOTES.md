# Review App — build notes

## U1: the file-path question (proved first)

**Question:** can a dropped multi-GB OBS MKV be read by path, streaming, without
FileReader or whole-file-in-memory over IPC?

**Method (what the app does):**

1. **Path:** Tauri's `onDragDropEvent` hands the webview the dropped files'
   absolute paths (`event.payload.paths`); no `File` object is involved. The
   frontend calls `open_media(path)`, which stats the file (size only) and adds
   that exact path to an in-memory allow-list.
2. **Bytes:** a custom URI scheme `media` (`src-tauri/src/media.rs`, registered
   with `register_asynchronous_uri_scheme_protocol`) serves the file by HTTP
   Range: seek + read only the requested bytes, on a worker thread. Open-ended
   ranges (`bytes=N-`) are capped at 4 MiB per response, explicit ranges at
   16 MiB, a request with no Range header gets a 206 for the first chunk (never
   a full 200 body), and paths not on the allow-list get a 403. URL =
   `convertFileSrc(path, "media")` → `http://media.localhost/<encoded path>` on
   Windows/WebView2, `media://localhost/...` on Linux/macOS.
3. **Consumers:** Mediabunny reads it with `UrlSource` (it always sends
   `Range: bytes=N-` and re-requests when a 206 ends early), and the scrubber's
   `<video>` gets the same URL as `src` (the media stack makes its own Range
   requests). Only the mic-track extract crosses IPC: one ~35 MB 16 kHz mono
   WAV per 18-min chunk, sent as a raw `invoke` body to `save_session_bytes`,
   which writes it into the session folder. Rust then reads it from disk to
   upload to Deepgram.

**Measured on this box (Linux):**

- **Rust Range serving on a 5 GiB sparse file** (`cargo test -- --nocapture`,
  `media::tests`, debug build, 5,368,709,120 B):

  | request | status | bytes served | time |
  |---|---|---|---|
  | `bytes=0-1048575` | 206 | 1,048,576 | 1.50 ms |
  | middle 1 MiB (`bytes=2684354560-2685403135`) | 206 | 1,048,576 | 0.61 ms |
  | middle, 100 MiB asked | 206 | 16,777,216 (capped) | 10.3 ms |
  | `bytes=5368709000-` (end) | 206 | 120 | 27 µs |
  | `bytes=1073741824-` (open-ended) | 206 | 4,194,304 (capped) | 2.2 ms |
  | `bytes=-4096` (suffix) | 206 | 4,096 | 17 µs |
  | no Range header | 206 | 4,194,304 | 0.36 ms |
  | `bytes=6000000000-` | 416 (`bytes */5368709120`) | 0 | 13 µs |

  Memory: VmRSS 7,224 → 11,892 KiB (+4.6 MiB), peak VmHWM +16.5 MiB, which is
  the single capped 16 MiB buffer. The test asserts both stay under 64 MiB.
  Memory is bounded by the per-response cap, not the file size.

- **Mediabunny over capped Range responses** (headless Chrome 1248 against a
  Node range server with the same cap rules as `media.rs`, on
  `test-media/obs-layout-test.mkv`, 928,277 B): probe returned duration 20 s,
  1280×720, audio Track 1 = AAC 2 ch 44.1 kHz, Track 2 = AAC 1 ch 48 kHz.
  Extracting Track 2 as two trimmed chunks (0–10 s, 10–20 s) gave two WAVs of
  320,044 B each: 1 ch, 16 kHz, 16-bit, exactly 10.0 s, RMS 4948 / 3888 (speech,
  not silence). With the open-ended cap forced down to 64 KiB it took
  **15 range requests, 928,277 B total**: the whole file read exactly once, no
  duplicate reads, identical output. That shows the re-request-on-short-206 path
  works.
- **Not measurable here:** an actual WebView2 run with a real multi-GB OBS file
  (no Windows, no multi-GB recording on this box). See the Windows checklist.

## What Cade must run on Windows (U1 sign-off)

Build: `npm install`, then `npm run tauri dev` (or `npm run tauri build` → NSIS
installer). WebView2 ships with Windows 11.

1. **Settings → Deepgram API key:** paste it once and Save. Status should read
   "key stored in OS keychain". Check that Windows Credential Manager → Windows
   Credentials has an entry for `app.reviewapp.desktop` / `deepgram`. Restart
   the app: status should still read stored, and you should not need to
   re-enter the key.
2. **Small file:** drop a 1–5 min recording made with the bundled OBS profile.
   Import should show filename, path, size, duration, 1280×720, and the audio
   tracks, with **Track 2 preselected** as mic. Pick a different track, drop the
   file again, and the picker should remember your choice.
3. **Transcribe:** the progress bar goes extracting → uploading → done; the
   stats line shows word count, duration and cost in cents. Open
   `%APPDATA%\app.reviewapp.desktop\sessions\<id>\`: it should contain
   `session.json`, `transcript.json` (words with start/end), `transcript.txt`,
   and `mic-000.wav`. Play the WAV: it should be mono, mic only, no game audio.
4. **Scrub & point:** the video plays in the left pane and the transcript is on
   the right. Click a line: the video jumps to that moment, and the line
   highlights and follows playback. Try −5s/+5s/speed. **If the video pane shows
   "cannot play this file as-is", WebView2 can't play the MKV directly.** Tell
   me: that triggers the MKV→MP4 remux fallback from DESIGN.md, which U1 does
   not build.
5. **Big file (the actual file-path proof on Windows):** drop a 1 h+, multi-GB
   recording. Watch the app's memory in Task Manager (Review App + the
   `msedgewebview2.exe` children). Import should appear within seconds, and
   memory should **not** climb toward the file size during import, scrubbing or
   transcription. Expect a few 18-min chunks (`mic-000.wav`, `mic-001.wav`, …),
   with transcript timestamps continuing correctly past each chunk boundary
   (click a line after 18:00 and after 36:00 and check that the video lands on
   the spoken words).
6. **RX580 / AMF:** the profile now records AMD AMF H.264 (DESIGN.md
   2026-11-08). Confirm that playback and seeking are smooth (hardware decode)
   and that mic extraction (WebCodecs AAC decode) works on that file.
7. **Path round-trip:** the allow-list compares exact path strings. If a
   dropped file on another drive, or one with spaces, `#` or non-ASCII in its
   path, fails with a 403 in the video pane, that string comparison is the cause.
8. **Wrong key:** set a bogus key and transcribe. You should get a plain error
   with the HTTP status (no key text in it) and a Retry button, and the
   extracted WAV should stay in the session folder.

## Testable without a Deepgram key

- `npm run test:unit`: chunk ranges/offsets, line grouping, line lookup, mic
  default (remembered → Track 2 → last), cost.
- `cd src-tauri && cargo test`: Range serving on a sparse multi-GB file, and
  the Deepgram request path against a local mock server (URL/model/headers/body,
  word parsing with chunk offsets, an error path that never leaks the key).

## Decisions / known limits (U1)

- New Rust deps (all named in DESIGN.md's needs): `keyring` 3 (OS keychain;
  `windows-native` on Windows), `ureq` 3 with rustls+ring (Deepgram upload from
  Rust, so the key never enters the webview; picked over reqwest, which wants
  aws-lc-sys/cmake for rustls), `serde_json` and `percent-encoding` (already in
  the lock). No new npm deps.
- The Deepgram key is write-only from the UI: `set`/`has`/`clear` only, and it
  is never returned to JS. `transcribe_chunk` only uploads files inside the
  sessions dir, and error text is redacted of the key.

- Mic audio sent as 16 kHz mono 16-bit WAV. No audio encoder is needed (WebCodecs
  Opus/AAC encode support varies by webview). Size: ~1.9 MB/min.
- Chunk length 18 min (inside the 15–20 band). A tail under 60 s folds into the
  previous chunk.
- Transcription is resumable within a run: Retry restarts at the failed chunk
  and keeps completed chunks.
- Mic-track choice is remembered in localStorage (one setup). If the user later
  needs per-OBS-setup memory, key it by track layout.
- Mode was fixed to "full" in U1; U2 adds the full/rapid toggle (Scrub screen, saved to session.json).
- No Library screen yet (U5): past sessions are on disk but not re-openable in
  the UI.

## U2: points, buckets, screenshots

**What it does (Scrub & point screen):**

- Each transcript line has a 📌 button. Pinning opens the point composer with
  the quoted line and its timestamp, a text field, the bucket picker and a
  screenshot button. Save writes the point. Lines with a point get a red
  left border.
- **Buckets** (`src/points.ts`): 14 full-mode buckets and 6 rapid-mode
  buckets, labels verbatim from DESIGN.md; a unit test asserts both lists. Rapid
  buckets have their own ids (`rapid-feel` = 3Cs + juice, which is not full
  mode's Game Feel/Juice). The **Mode** select (full / rapid) sits above the
  points list and is saved to `session.json`. Switching modes keeps every point;
  points from the other mode keep their bucket and show "(rapid)" in the label.
  No scores anywhere.
- **Points list**: filter by bucket (counts shown), click the timestamp to jump,
  click the thumbnail to jump to the screenshot's frame, Edit (loads the point
  into the composer: change text/bucket/screenshot), Delete (second click
  confirms; the point's JPEG is deleted too).
- **Screenshots**: `grabFrame` in `src/media.ts`. Primary path: canvas
  `drawImage(video)` at the source resolution, then `toBlob` JPEG 0.85. Fallback:
  Mediabunny `CanvasSink.getCanvas(currentTime)` on the original file, used when
  there is no decoded frame or the canvas is tainted. The `<video>` is now
  `crossOrigin="anonymous"` so the canvas stays clean (the media scheme already
  sends `ACAO: *`). If the webview refuses the CORS-mode load, the player
  silently reloads without `crossOrigin` and screenshots use the Mediabunny
  path. A grab stays in memory until Save, so a cancelled point leaves no
  orphan file. The transport bar's Screenshot button grabs into the open
  composer, or starts a point on the line playing now.
- **Persistence**, in the session folder: `points.json`
  (`{version, next, points:[{id, bucket, quote, time, text, screenshot,
  shot_time, order}]}`) and `shot-<pointId>-<ms>.jpg`. `screenshot` is a file
  name relative to the session folder, not an absolute path, so the folder stays
  movable. `order` is the creation order and is never reused (`next` survives
  deletes). Pinned-line marking matches `point.time` to the line's start time.
- **Rust**: `save_audio_chunk` is renamed to `save_session_bytes` (generic raw
  body; WAVs and JPEGs). New: `load_session_bytes` (raw `ipc::Response` →
  Blob URL thumbnails) and `delete_session_file`. All of them go through the
  same id/name validation. No new dependencies.

**Verified here:** `bash ops/check.sh` passes. `npm run test:unit` passes 10/10
(5 new in `points.test.mjs`: bucket lists, create/edit/delete order, filter +
pinned, parse round-trip/damage, file names). `cargo test` passes 10/10. In
headless Chromium 1248, a cross-origin Range server serving
`test-media/obs-layout-test.mkv` with `ACAO: *`, a scratch page calling
`grabFrame`: the canvas path gave a 1280×720 JPEG (25,972 B) at 7.3 s with an
untainted canvas, and the forced Mediabunny fallback gave the same 1280×720
frame (25,972 B).

**Known limits:** there is no Library yet, so points are reloaded only for the
session you just transcribed (re-opening past sessions is U5). Pinned-line
marks depend on the line grouping staying the same as when the point was made.

## What Cade must verify on Windows (U2)

1. **Pin + save:** on the Scrub screen, click 📌 on a line, type a point, pick
   a bucket, Save. The point appears in the list and the line gets a red left
   border. `%APPDATA%\app.reviewapp.desktop\sessions\<id>\points.json`
   contains it.
2. **Screenshot (WebView2 + RX580):** pause on a frame and click Screenshot. The
   composer status should say `via video`. If it says `via mediabunny`, the
   canvas was tainted or the frame wasn't ready. That still works, but tell
   me. Open the `shot-*.jpg` in the session folder: it should be 1280×720, the
   right frame, and not black. A black or green JPEG from the canvas path on the
   AMD hardware-decoded video is the main thing to look for.
3. **Video still plays with `crossOrigin` set:** if playback broke compared to
   U1, or the screenshot is always `via mediabunny`, WebView2 refused the
   CORS-mode load of `http://media.localhost` and the reload fallback kicked in.
4. **Edit / delete:** edit a point's text, bucket and screenshot (replace and
   remove), then delete a point. The old JPEGs should disappear from the session
   folder and `points.json` should match the list.
5. **Filter / jump / mode:** filter by bucket and check the counts. Click a
   point's timestamp and the video should land on the quoted words. Switch Mode
   to Rapid: the picker shows the 6 rapid buckets, the existing full-mode points
   stay listed, and `session.json` shows `"mode": "rapid"`.
