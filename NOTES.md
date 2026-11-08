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

## U3: Assemble stage + AI draft

**What it does:** the Scrub screen has an **Assemble →** button. The Assemble
screen has the editor on the left and a live preview on the right.

- **Segmented editor:** there is one section for each bucket that has points.
  Sections follow the current mode's bucket order; buckets from the other mode
  come after them. Each section has a prose textarea above its points
  (timestamp, note, quote, thumbnail). The logic is in `src/review.ts`
  (`sectionBuckets`, `pointsIn`).
- **Review settings:** game title (saved to `session.json`), mode full/rapid
  (shared with the Scrub screen's Mode select, saved to `session.json`),
  verdict wording, and a who-it's-for line. **Score** is optional free text and
  appears in **full mode only**. In rapid mode the field is hidden, the score
  is not rendered, and it is never sent to the AI (a test asserts this). A
  score typed in full mode stays in `review.json` but is ignored while the
  session is in rapid mode.
- **Persistence:** `review.json` in the session folder:
  `{version, verdict, who_for, score, sections:{<bucket>:{prose, draft}}, publish_state}`.
  Writes are debounced (400 ms) and flushed when you go back to Scrub.
  `publish_state` stays `"draft"` until U4.
- **Live preview** (`renderPage` in `src/review.ts`): one self-contained HTML
  document with no scripts and no external assets, shown in an
  `<iframe sandbox="allow-same-origin" srcdoc>` (scripts are blocked; same
  origin lets the blob-URL screenshots load). It re-renders 250 ms after
  typing and keeps the scroll position. The style follows the HG101/GameFAQs
  idiom with Neocities touches: an ASCII box banner, a numbered CONTENTS list,
  `[01]` numbered section headers with `=-=-` rules, readable Georgia body
  text, monospace "FIELD NOTES" with `[m:ss]` stamps, a tiled 8×8 pixel
  checker background (a data-URI SVG, no image files), 88×31-style badges and
  a hard-shadow page frame. U4 should reuse `renderPage` with `shotUrl`
  mapping to relative file paths for export.
- **AI draft (Gemini):** the "AI draft (Gemini)" button sends the section
  buckets + points + verdict/who-for (`draftPrompt`) with a system instruction
  (`DRAFT_SYSTEM`: HG101 voice, only use the notes, no invented facts, no
  scores, JSON reply). The reply's prose goes into **empty sections, and
  sections that still hold an unsigned draft, only**. Prose you wrote yourself
  is never overwritten (`applyDraft`; tested). Draft sections are marked
  everywhere:
  - in the editor: a red dashed border, an "AI DRAFT" badge, and an
    "I've edited this — it's mine now" sign-off button. Typing alone does
    not clear the flag; sign-off does.
  - above the editor: a warning with the count of unsigned sections.
  - in the preview: a red dashed "AI DRAFT - NOT REVIEWED" box, plus a
    page-top notice.

  Nothing publishes automatically. U4 should refuse to export (or require an
  explicit override) while `unreviewedDrafts()` is non-empty.

### Model/key flow (settled)

- **Key:** Settings → "Gemini API key" (optional; the settings panel does not
  force open for it). Stored in the OS keychain: service
  `app.reviewapp.desktop`, user `gemini`, alongside `deepgram`. It is
  write-only from the webview: `set_gemini_key` / `has_gemini_key` /
  `clear_gemini_key`, and the key never goes back to JS. The Deepgram key
  commands now share the same helpers (`set_key`/`has_key`/`clear_key`/`get_key`
  in `lib.rs`).
- **Call:** `gemini_draft(model, system, prompt)` runs in Rust
  (`src-tauri/src/gemini.rs`, the same ureq/rustls pattern as Deepgram, no new
  deps). It sends `POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`
  with the key in the `x-goog-api-key` header (not in the URL), plus
  `systemInstruction`, `responseMimeType: application/json` and temperature
  0.7. Timeouts are 30 s connect / 120 s total. Input is capped at 200 KB.
  Error strings carry the HTTP status and redact the key. A blocked prompt
  (`promptFeedback.blockReason`) or an empty finish gets a plain message. The
  frontend parses `{"sections":{<bucket id>: prose}}`, tolerates a ```json
  fence, and drops unknown bucket ids.
- **Model:** default `gemini-2.5-flash`, changeable in Settings (stored in
  localStorage `ra.geminiModel`; an empty field uses the default). Flash is
  enough for rewriting notes into prose and is cheap; a full review's prompt
  is a few KB. If Google retires 2.5-flash or a newer Flash is better, change
  the model field; no rebuild needed. (`DEFAULT_MODEL` in `gemini.rs` and the
  fallback in `main.ts` only matter when the field is empty.)
- **Privacy:** the only data sent is the title, mode, verdict, who-for and the
  point notes/quotes. No audio, no screenshots, and no key outside the header.
  This adds a network call that DESIGN.md's "Local-first" list doesn't name
  (it lists Deepgram + Cloudflare). The AI-draft ruling covers it, and the
  call is opt-in per click.

**Verified here:** `bash ops/check.sh` passes. `npm run test:unit` passes
17/17 (7 new in `review.test.mjs`: section order, review.json round-trip and
damage tolerance, prompt contents and no score, draft parsing, never
overwriting your own prose, HTML escaping + numbering + draft marks + no
score in rapid mode, banner box width). `cargo test` passes 16/16 (gemini:
URL building, response parsing incl. multi-part / SAFETY block / RECITATION /
garbage, end-to-end against a mock server checking path, header, no key in
the URL and body shape; 400/403 with the key echoed back are redacted; input
cap). I rendered a sample page with `renderPage` and screenshotted it in
headless Chromium: banner, contents, numbered sections, draft box and verdict
box all render.

**Not verified here:** a live Gemini call (no key on this box). The Assemble
screen's DOM was typechecked and built, but not clicked through in a webview.
The research report under `~/workspace/research_notes/…` is not readable by
the `builder` user (permission denied), so the page style follows DESIGN.md's
description only.

**Known limits:** no Library yet, so Assemble works on the session you just
transcribed (U5). Points can't be edited from the Assemble screen; go back to
Scrub. The preview uses blob URLs for screenshots, and export (U4) must map
them to files.

## What Cade must verify on Windows (U3)

1. **Assemble opens:** after pinning a few points in 2–3 buckets, click
   **Assemble →**. You should see one section per bucket with points, in bucket
   order, with points and thumbnails under each prose box. The preview on the
   right shows the styled page with screenshots. If screenshots are broken in
   the preview but fine in the editor, WebView2 is refusing blob URLs inside
   the `srcdoc` iframe. Tell me.
2. **Live preview:** type in a section, the verdict and the who-for line. The
   preview updates within about ¼ s and keeps its scroll position. Check the
   look at your normal window size: tiled background, ASCII banner, numbered
   headers, badges.
3. **Settings + mode:** switch Mode to Rapid. The Score field disappears and
   the score vanishes from the preview, and the Scrub screen's Mode select
   matches when you go back. Rename the title and check that `session.json`
   updates. Check that `review.json` in the session folder has your prose.
4. **Gemini key:** Settings → paste the Gemini key → Save. It should say
   "key stored in OS keychain", and Credential Manager should show
   `app.reviewapp.desktop` / `gemini`. It should survive a restart.
5. **AI draft:** write your own prose in one section, leave the others empty,
   then click **AI draft (Gemini)**. The empty sections fill with red-dashed
   "AI DRAFT" prose, your section stays untouched, and the status line says
   how many were filled/kept. The preview shows "AI DRAFT - NOT REVIEWED"
   boxes. Click "I've edited this — it's mine now" on one. Its marks should
   go away in the editor and the preview, and the warning count should drop.
6. **Draft quality / model:** read the drafts. They should only restate your
   notes, not invent mechanics. If `gemini-2.5-flash` errors with 404
   (retired) or the prose is weak, put a different model id in Settings →
   Gemini model and retry. Tell me which one works so the default can change.
7. **Bad key:** set a bogus Gemini key and click AI draft. You should get a
   plain "AI draft failed: Gemini HTTP 400/403 …" error with no key text,
   and your prose should be unchanged.

## U4: Publish (Cloudflare Pages) + Itch comment

**What it does:** Assemble has a **Publish →** button that opens the Publish
screen. It has three steps; nothing happens unless you click.

- **Draft gate:** while any section holds unsigned AI draft text, Export and
  Publish are disabled. An "Export anyway" checkbox overrides this, and the
  page then keeps its red AI DRAFT marks.
- **1. Save files locally:** writes this review into the local **site folder**
  `%APPDATA%\app.reviewapp.desktop\site\`:
  - `index.html`: a front page listing every exported review, newest first.
  - `<slug>/index.html`: this review, from `renderPage` with screenshots at
    `shots/<name>`.
  - `<slug>/shots/*.jpg`: copied from the session folder. Shots the page no
    longer uses are pruned.
  - `reviews.json`: the entry list. It stays local and is never uploaded.

  The slug comes from the title, is made unique against other sessions, and is
  saved in `review.json` on first export so the link doesn't change if you
  rename the game. This folder is the **manual fallback**: drag it into the
  Cloudflare dashboard's Pages upload.
- **2. Publish to Cloudflare Pages:** the first click arms the button and
  names the project; a second click within 5 s uploads. It re-exports first,
  then uploads the **whole site folder** as a new production deployment.
  Every deploy replaces the site, so every review has to be in each upload.
  The flow is the same as `wrangler pages deploy`
  (`src-tauri/src/cloudflare.rs`):
  1. GET project → `subdomain` + `production_branch` (on 404 it creates the
     project with `production_branch: main`).
  2. GET `upload-token` (JWT).
  3. `check-missing`, then `assets/upload` sends only the files the server
     lacks (base64, batches of ≤40 MiB / 2000 files).
  4. `upsert-hashes`.
  5. Multipart `deployments` with `manifest` `{"/path": hash}` and
     `branch` = the project's production branch.

  Asset keys are wrangler's exact hash, `blake3(base64(bytes)+ext)[..32]`
  (a wrong key is accepted silently and then 404s). The API token is used
  for the account endpoints and the JWT for asset endpoints, both only in
  `Authorization`; errors carry the HTTP status + Cloudflare
  `code: message` with secrets redacted. After a successful publish,
  `review.url = <site URL>/<slug>/` and `publish_state = "published"`.
- **3. Itch comment:** `hook + "Verdict: <first sentence>" + "Full review: <url>"`.
  - The hook is the first sentence of the Overview section's prose (falls
    back to the first Overview point, then any prose).
  - Before publishing, the link reads `[link — publish first]`. Publishing
    fills it in: it regenerates the comment if you hadn't edited it, and
    otherwise only swaps the placeholder.
  - The comment is editable and saved in `review.json` (`itch_comment`).
  - **Copy** uses `navigator.clipboard`, with an `execCommand("copy")`
    fallback. **Regenerate** rebuilds the comment.
  - Nothing is ever posted to Itch.
- **Settings:**
  - Cloudflare API token: OS keychain, user `cloudflare`, write-only like the
    other keys.
  - Account ID (32 hex), Pages project name, and an optional Site URL
    override for a custom domain: stored in localStorage (not secrets).
    Default site URL is `https://<project subdomain>` from the API.
- **New dependency:** `blake3` (`pure` feature: Rust only, no C/asm build).
  DESIGN.md's direct-upload ruling needs wrangler's hash, and hand-rolling
  crypto was the worse option. No other new deps; base64 and multipart are a
  few lines each.

**Verified here:**
- `bash ops/check.sh` passes.
- `npm run test:unit` passes 23/23. The 6 new tests in `publish.test.mjs`
  cover: slugify/unique slug/saved slug sticks, entries parse + upsert,
  index escaping, site URL normalisation, the comment format + placeholder,
  and the review.json publish fields.
- `cargo test` passes 23/23. The 7 new tests: base64 vectors; hash pinned
  to BLAKE3 (`blake3("")` vector); file collection skips
  `reviews.json`/`*.tmp`; export writes, prunes and validates.
- Against a **local mock Cloudflare API** (no real publish has ever run):
  - full 6-call flow: auth per endpoint, only missing files uploaded,
    manifest covers every path, branch = the project's `production_branch`;
  - first-publish project creation;
  - a 403 whose body echoes the token comes back redacted.

**Not verified here:** a real Cloudflare upload (no token on this box, and
the loop must never publish). The Publish screen's DOM was typechecked and
built but not clicked through in a webview.

**Known limits:**
- Publishing does not poll the deployment until it goes live (wrangler polls
  5×), so the link can take a minute.
- There is no JWT refresh-on-expiry (wrangler re-fetches on 8000013). This
  only matters for uploads over a few minutes; if it happens, just Publish
  again: files already uploaded are skipped.
- No retry on Cloudflare 8000000.
- Re-publishing a review deletes nothing remotely except via the full-site
  replace. To unpublish, remove its folder from `site\` and publish again.

## What Cade must verify on Windows (U4)

1. **Token setup:** create a Cloudflare API token with **Account ›
   Cloudflare Pages › Edit**. Settings → paste it → Save token: it should
   say "token stored in OS keychain", and Credential Manager should show
   `app.reviewapp.desktop` / `cloudflare`. Fill in Account ID (dashboard
   sidebar / URL) and a project name (e.g. `reviews`).
2. **Draft gate:** with an unsigned AI draft section, Publish → Export and
   Publish should be disabled until you tick "Export anyway" or sign the
   section off.
3. **Save files locally:** click it. The path should be shown. Open
   `%APPDATA%\app.reviewapp.desktop\site\<slug>\index.html` in a browser:
   the styled page with screenshots loading from `shots\`. The site's
   `index.html` should list the review.
4. **First real publish:** click Publish twice. On a new project name it
   should create the project, then report "Published (deployment https://…)".
   Open the link shown under it (`https://<project>.pages.dev/<slug>/`)
   after a minute: the page and screenshots should load. If the screenshots
   404 but the HTML loads, the asset hash doesn't match Cloudflare's. Tell me.
5. **Second review:** publish another game. Both reviews and the front page
   should stay live, and the status should say only a few new files were uploaded (the earlier review's files are skipped).
6. **Errors:** try a wrong account ID or a token without Pages permission.
   You should get a plain "Cloudflare … HTTP 403: 10000: Authentication
   error" style message with no token text, and the local files should be
   untouched.
7. **Itch comment:** check the comment reads hook / verdict / link. Click
   **Copy** and paste into Notepad. If Copy says it failed, WebView2 refused
   both clipboard paths. Tell me.
8. **Custom domain (optional):** set Site URL to your domain; the next
   publish's link and comment should use it.
