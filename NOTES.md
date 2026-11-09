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

## U5: Library + demo-day queue

**What it does:**

- **Library screen:** the app now boots directly into the Library screen (`screen-library`), listing every session found in `%APPDATA%\app.reviewapp.desktop\sessions\<id>\`.
- **Session folder layout:** each session is an isolated directory containing:
  - `session.json`: `{id, title, event, recording_path, date, mode, mic_track, duration}`
  - `mic-NNN.wav`: extracted mic audio chunks (16 kHz mono)
  - `transcript.json` / `transcript.txt`: Deepgram word timestamps and plain transcript
  - `points.json`: review points with timestamps and bucket assignments
  - `shot-*.jpg`: screenshots grabbed during scrubbing
  - `review.json`: draft/final review prose, verdict, who-for, score, and publish state
- **Table columns:** Game title (editable inline), Event (editable inline), Date (`YYYY-MM-DD HH:MM`), Clip length (formatted `m:ss` or `h:mm:ss`), Status badge, Points count, and Actions (`Open`, `Queue`/`Unqueue`, plus a `recording missing` warning if the video file path no longer exists).
- **Status ladder** (`deriveStatus` in `src/library.ts`):
  - `imported`: session registered, not transcribed yet
  - `transcribed`: `transcript.txt` exists
  - `points pinned`: `points.json` contains at least one point
  - `review done`: all bucket sections have prose, verdict is written, and no unreviewed AI drafts remain (or review was exported)
  - `published`: review was published to Cloudflare Pages
- **Searchable by game/event:** case-insensitive multi-term search filtering against title and event fields simultaneously (`searchRows`).
- **New session intake:**
  - **Drag and drop:** dropping files onto `#lib-drop` (or anywhere on the window) probes media length via Mediabunny and creates `session.json`.
  - **Native file picker:** `Pick recordings` button calls Tauri `pick_recordings` (`tauri-plugin-dialog`), opening a native modal multi-file dialog with filters (`*.mkv`, `*.mp4`, `*.mov`, `*.webm`).
  - **Single recording (normal mode):** automatically opens the session immediately (to Scrub if already transcribed, or Import if mic track needs selection).
  - **Demo-day mode:** checkbox sets rapid review mode (`mode: "rapid"`) and enqueues imported recordings directly into the demo-day queue.
- **Demo-day queue:**
  - Persisted in `localStorage["ra.queue"]`.
  - In Library: `#queue-box` displays queued items with progress (`X of Y done`), reorder `↑`, unqueue `×`, `Work next →` button, and `Clear finished`. Completed sessions are crossed out.
  - Across active screens: persistent `#queue-bar` in the header shows current position (`Demo day: 1 of 5`) and a dynamic `Work next: <title> →` button to advance to the next unfinished session.
  - When all queued sessions are finished, the app reports `"Every queued recording is done."` and returns to the library.
- **Header navigation:** `← Library` button (`#nav-library`) is visible on every non-library screen (Import, Transcribe, Scrub, Assemble, Publish) to safely save edits and return to the library.
- **Backend resilience:** `list_sessions_in` in Rust safely skips non-directory or invalid-id entries, gracefully ignores damaged optional files (`read_optional`), and verifies recording existence on disk without loading large transcript JSONs into memory.

**Verified here:**
- `bash ops/check.sh` passes (typecheck + vite build + cargo build).
- `npm run test:unit` passes 29/29 tests (including 6 library unit tests covering status ladder, pre-U5 session backwards compatibility, search filtering, queue enqueue/pruning/wrap-around, and filename sanitization).
- `cargo test` passes 24/24 tests (including `list_sessions_scans_valid_dirs`).

## What Cade must verify on Windows (U5)

1. **Boot into Library:** run `npm run tauri dev`. The app should open into the Library screen, showing the session table (or "No sessions found" if fresh) with the top toolbar (Pick recordings, Event, Demo-day mode, Search).
2. **Native file picker:** click `Pick recordings`. Windows File Open dialog should open, modal to the main window, with file filters for `Recordings (*.mkv, *.mp4, *.mov, *.webm)` and `All files (*.*)`. Select one or multiple OBS recordings.
3. **Single drop/pick (normal mode):** pick or drop a single recording with Demo-day mode unchecked. The app should probe it, create the session folder, and immediately open it into the Import or Scrub screen.
4. **Header navigation:** on the Import/Scrub screen, click `← Library` in the top bar. The app should return to the library, and the new session should be listed in the table with its title, date, duration, and status.
5. **Inline editing:** click into the Game title or Event input in any table row and type a new name. Click outside or press Enter. Check `%APPDATA%\app.reviewapp.desktop\sessions\<id>\session.json` to verify the new title/event persisted.
6. **Search:** type a game name or event keyword into the search box. The table should filter in real-time and update the `X of Y sessions` count.
7. **Demo-day mode queue:**
   - Tick `Demo-day mode (rapid review + queue)`.
   - Enter an event name (e.g. `Demo Day Nov 2026`).
   - Pick or drop 2–3 recordings.
   - Verify they are added to the table with `rapid` mode and appear in the `Demo-day queue` box above the table.
   - Use `↑` to reorder items in the queue.
   - Click `Work next →` on the queue box: it should open the first recording.
8. **Queue bar progression:**
   - While working on the session (Import → Transcribe → Scrub → Assemble), check the header: it should display `Demo day: 1 of N` and `Work next: <Game 2> →`.
   - Complete the review (or click `Work next`). It should cleanly flush `review.json` and advance to the next session.
   - Once all queued sessions are finished, clicking `Work next` should return to the library with "Every queued recording is done." and completed sessions crossed out in the queue list.


## U6: Compress-clip button (Scrub & point)

**What it does:** under the scrubber's transport, `Mark In` / `Mark Out` take the
video's current time (the times next to them are click-to-jump). `Compress clip`
renders the Compression Protocol outputs over [In, Out] one at a time and writes
them into the session folder as `clip_<in>-<out>_<Output>.<ext>` (e.g.
`clip_1m02.5-1m20.0_Discord.mp4`). The same range overwrites its earlier files
atomically. The `Socials pack` checkbox (off by default, as in Clip Sizer) adds
the three 1080p shapes, and the select sets their background (Fit / Fill /
Gradient). Each file gets a result line: size, frame, codec, kb/s, audio, attempts,
under/OVER cap, and path. Length warnings never block: 4chan starves past 45 s,
and Socials is over the X limit past 2:20.

**Engine:** Mediabunny `Conversion` (WebCodecs), ported from Clip Sizer's
hardware engine. Frames are composited on an OffscreenCanvas, the source is read
by Range through the `media` scheme (`UrlSource`), and the output is a
`BufferTarget` saved with `save_session_bytes`. There is no transcoder besides
Mediabunny and no FFmpeg. Clip Sizer's FFmpeg.wasm CPU fallback was deliberately
**not** ported, so if the webview cannot encode an output, that output fails with
a plain message and the remaining outputs still run. Code: presets/math in
`src/clip.ts` (unit-tested in `src/clip.test.mjs`), encoder in
`src/media.ts` (`encodeClip`, `sampleColors`), UI in `src/main.ts` §3c.

**Preset values used** (from Clip Sizer's code constants, `index.html` v44; its
README prose says 4.0 MB / 3.89 MB for 4chan, but the code it runs uses the values
below):

| Output | Container / codec | Frame | Video | Audio | Size |
|---|---|---|---|---|---|
| Discord | MP4 (fastStart in-memory) / H.264 | source shape, long side ≤1080 by bitrate tier | `floor((19e6·8/len/1000 − 128)·0.94)` kb/s, CBR, floor 80 | AAC 128k CBR stereo, game track | target 19 MB, hard cap 19.9 MB |
| 4chan | WebM / VP9, key frame every 20 s | source shape, long side aimed at 1280, floored at 960 (if source ≥960) | `floor(4.09e6·8/len/1000·0.97)` kb/s, VBR, floor 70 | muted | target 4.09 MB, hard cap 4,194,304 B |
| Horizontal | MP4 / H.264 | 1920×1080 | 8000 kb/s CBR | AAC 128k CBR stereo | no cap |
| Vertical | MP4 / H.264 | 1080×1920 (fitted clip centred 40% down) | 8000 kb/s CBR | AAC 128k CBR stereo | no cap |
| Square | MP4 / H.264 | 1080×1080 | 8000 kb/s CBR | AAC 128k CBR stereo | no cap |

All outputs are 30 fps. Resolution tiers ("Mixed", thresholdScale 1): <180 kb/s
→ 360, <350 → 480, <650 → 720 on the long side, else the output's cap, never
upscaled. Over-cap retry (Discord/4chan only): up to 2 re-encodes, at
`kbps × cap/size × 0.95` (floored at the minimum). Gradient: per-channel median
of 5 sampled frame averages (10/30/50/70/90% of the range), stops ×0.45 / ×0.75,
plus a 2px outline (the lighter stop blended 30% toward white). Game audio = Track 1, or the
first track that isn't the session's mic track. With no such track, Discord and Socials
come out silent and the result line says so.

Faithful-port quirk, kept on purpose: Clip Sizer's Discord frame cap is 1080 on
the **long** side, so a 1280×720 OBS recording becomes **1080×606** for Discord,
even with a large bitrate budget. The 4chan file stays 1280×720. If Cade wants
Discord at native 720p, change both apps together.

**Verified here** (headless Chromium 153 shell, current `media.ts`, Range
server with the media.rs caps, `test-media/obs-layout-test.mkv`, range 2–12 s):
- 4chan: 1,864,511 B, 1280×720 VP9, 10.000 s, no audio, 1 attempt: PASS.
- Discord / Horizontal / Vertical / Square **with game audio: FAIL** with "this
  webview cannot encode AAC audio". Linux Chromium has no AAC `AudioEncoder`
  (Opus/PCM only). Re-run muted, all four passed: Discord 1,453,293 B 1080×606,
  Horizontal 3,332,030 B 1920×1080, Vertical 1,685,742 B, Square 1,461,205 B.
  All files are H.264 High, 30 fps, 300 frames, exactly 10.000 s.
- Vertical frame inspected: the gradient bars, the clip at gaze height, and the 2px outline are all there.
- Retry loop: with the cap forced down to 800 KB it ran 3 attempts and
  stopped 3% over. The UI reports such files as "OVER the cap; trim shorter",
  not as success.
- Encoders undershoot CBR targets on easy content (Discord asked 14 Mb/s, got
  ~1.2 Mb/s on test bars). That's harmless for caps, but don't expect sizes to
  match the budget.
- `npm run test:unit` 39/39, `bash ops/check.sh` OK. Not run inside the Tauri
  webview on this box (WebKitGTK is only the compile gate).

## What Cade must verify on Windows (U6)

1. **AAC encode in WebView2 (the main risk).** Open a transcribed session, Mark
   In at ~0:10 and Out at ~0:30, and click Compress clip. The Discord line must say
   `AAC 128k (Track 1)`, and the MP4 must play **with game audio, no mic** in a
   player and in a Discord upload. If it says "cannot encode AAC audio", WebView2
   lacks AAC. The fix would be Clip Sizer's `@mediabunny/aac-encoder` WASM
   fallback, which is a new dependency, so it needs a ruling.
2. **H.264 + VP9 on the RX580.** Check that all files are produced and play. Clip
   Sizer runs the 4chan VP9 on the hardware path; on AMD it may fall back to
   software VP9, which is slower but fine.
3. **Caps on real gameplay** (busy footage, not test bars): a 30 s clip must give
   Discord ≤19.9 MB and 4chan ≤4 MiB, both "(under the cap)". Try a 60 s clip
   too: 4chan should still be under its cap, and blocky is expected there.
4. **Socials pack:** tick it, pick Gradient, and compress a ≤20 s clip. Check
   that three 1080p MP4s with audio appear, and that Vertical has gradient bars
   with the clip 40% down. Watch memory: each file is built in RAM and then sent over
   IPC (≈120 MB per shape at 2:00), so try one 2:00 Socials run and confirm the
   app stays responsive.
5. **Files land in** `%APPDATA%\app.reviewapp.desktop\sessions\<id>\clip_*`.
   Re-running the same range overwrites the old files rather than duplicating them.

## AI draft provider dropdown (2026-11-09, main-agent follow-up, not a loop unit)

- Settings → "AI draft provider" dropdown: Gemini (default), Claude, OpenAI, OpenAI Compatible.
- One keychain slot per provider (`gemini`, `claude`, `openai`, `openai_compat`); the key/model rows follow the dropdown, and the model is remembered per provider in localStorage (`ra.aiModel.<provider>`). A model saved under the old Gemini-only key (`ra.geminiModel`) migrates once into `ra.aiModel.gemini`.
- OpenAI Compatible shows a Base URL row (placeholder + fallback `https://nano-gpt.com/api/v1`; verified live — `/v1/models` returns 200). NanoGPT is the worked example; OpenRouter / local servers take any OpenAI-compatible base URL.
- Each provider row links to its key page: Gemini → AI Studio, Claude → console.anthropic.com/settings/keys, OpenAI → platform.openai.com/api-keys, Compatible → nano-gpt.com/api.
- Backend: new `src-tauri/src/claude.rs` (Messages API, `anthropic-version: 2023-06-01`, no JSON mode — the system prompt carries "reply with JSON only") and `src-tauri/src/openai.rs` (chat/completions, `response_format: json_object`, shared by OpenAI + Compatible). One `ai_draft(provider, model, base_url, system, prompt)` command routes; `gemini_draft` removed. Keys stay header-only; error paths redact the key, same as Gemini.
- Defaults: Gemini `gemini-2.5-flash`, Claude `claude-sonnet-4-5`, OpenAI `gpt-4o-mini`, Compatible blank (placeholder suggests a NanoGPT model id).
- `bash ops/check.sh` OK; `cargo test` 34/34 (new mock-server tests for both clients). Frontend renders in a plain browser (dropdown switching verified headless); not run in a webview on this box.
- What Cade must verify on Windows: pick OpenAI Compatible, paste a NanoGPT key, leave the base URL as-is, type a NanoGPT model id, and run an AI draft on a real session — the draft should fill from the NanoGPT model. Also confirm the Gemini default still works unchanged.
