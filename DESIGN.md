# Review App — Design Sketch

Working title: **Review App** (name still open). A Windows desktop app for reviewing many games in rapid succession — demo-day speed, HG101/GameFAQs-grade output.

Status: sketch, 2026-11-08. All platform/pipeline rulings locked, including 3Cs = Character/Controls/Camera (confirmed 2026-11-08). Open: app name.

Research behind this: the 14-bucket taxonomy, HG101 house rules, GameFAQs FAQ anatomy, demo-day triage model, and critical-thinking prompts live in the research report (`~/workspace/research_notes/game-review-structure-research-20261108-0652/report.md`) and the `game-review-research` page.

## Locked rulings (Cade)

- **Platform:** Windows Desktop based (2026-11-08 ~12:00 CST).
- **Recording:** no in-app recorder — removed 2026-11-08 ~12:39 CST. Record in OBS with the bundled Review App profile (`review-app/obs-profile/`): 1280x720 30fps, x264 CRF 20, MKV, Track 1 = game audio, Track 2 = mic (mono). Mic chain: RNNoise suppression, gentle gate, compressor, limiter, for cleaner transcripts.
- **One recording per game.** One game per session.
- **Transcription:** Deepgram (2026-11-08 ~12:04 CST; model-configurable, default Nova-3 per research 2026-11-08 — Nova-2 prerecorded pricing no longer appears in Deepgram's main pricing table and new projects are pointed at Nova-3; ~$0.0043/min per secondary sources, verify in the Deepgram Console before committing). Word-level timestamps, $200 signup credit. Mic commentary track ONLY — no game audio. Mediabunny extracts the mic track and downmixes to mono (stereo doubles billable minutes); chunk long files ~15–20 min with timestamp offsets (async callback needs a public webhook, unusable local-first).
- **Clips:** low resolution, crispy bitrate. (Research flag: low-res + crispy is a contradiction — the low-res proxy is for playback, the original file is kept for stills.)
- **Scrubber:** a video player, transcript beside it.
- **Review output:** full reviews on Cloudflare Pages (ruled 2026-11-08 ~12:17 CST — Neocities was the vibe pick, Cloudflare the practical one), classic HG101 / GameFAQs-styled design, segmented into parts, with Neocities charm: hand-built retro-web feel — personal-site energy, tiled backgrounds, pixel touches, visible hand-coding, no corporate polish.
- **Itch comment:** paste-ready text with a link to the full review. Auto-post unnecessary (2026-11-08 ~12:03 CST).
- **Stack (Tauri, locked 2026-11-08 ~15:28 CST for the loop start):** Tauri — Rust shell + TypeScript frontend, system webview via WebView2 on Windows, no bundled Chromium. Keyring crate for API keys (Deepgram + Cloudflare + Gemini draft keys) in the OS keychain; drag-drop events hand the backend real absolute paths (solves the multi-GB OBS import). Supersedes Electrobun (ruled 2026-11-08 ~12:31 CST, set aside the same day: no safeStorage equivalent, dropped files have no `.path`). Provenance: Cade asked "Tauri?" 2026-11-08 ~12:33 CST; locked on the loop order — overturn in one line.
- **AI draft (ruled 2026-11-08 ~15:28 CST):** the Assemble stage MAY use AI to turn the buckets/points into a coherent review draft. Draft only — the user edits it, nothing auto-publishes. Default provider: Gemini API (key in the OS keychain via the Tauri keyring crate); the loop settles the exact model/key flow in the Assemble unit. The draft is marked as a draft in the UI.

## The flow

Five stages, one window, one game per session:

```
Import → Transcribe → Scrub & point → Assemble → Publish
```

1. **Import** — drop in the MKV recorded with the Review App OBS profile (`review-app/obs-profile/`). The app reads the file, shows duration/resolution, and lists the audio tracks. OBS doesn't embed source names, so the app must show a track picker with previews and remember the choice; Track layout from the profile: Track 1 = game/desktop audio, Track 2 = mic (mono). The app extracts the mic track with Mediabunny and sends a mono clip to Deepgram. No proxy, no FFmpeg: the low-res MKV plays directly (hardware decode), Mediabunny remuxes to MP4 on import only if the webview can't play the MKV as-is, and screenshots come from the video element.
2. **Transcribe** — extract the mic track with Mediabunny (downmix to mono), send it to Deepgram, get back a timestamped transcript (word-level). Progress shown; transcript stored with the project.
3. **Scrub & point** — video player + transcript side by side. Click a transcript line to jump the video to that moment. Pin a line as a review point: it lands in a bucket, with its timestamp, the quoted line, and an optional screenshot grabbed from the current frame.
4. **Assemble** — segmented review editor. Points sit in their buckets; write/adjust the prose per segment; preview the HG101/GameFAQs-styled page.
5. **Publish** — export the finished review to Cloudflare Pages via direct upload (wrangler `pages deploy` or the direct-upload API — upload files, done; no git objects needed); generate the paste-ready Itch comment (short summary + link). Auth: Cloudflare API token. Free plan has unlimited bandwidth and 500 deploys/month. Drafts stay local until published.

## Screens

### 1. Library
- List of games/sessions, one row per recording: game name, date, clip length, status (imported / transcribed / points pinned / review done / published).
- New session: drop a file or pick one. Demo-day mode: queue several recordings, work them in order.
- Each session is a folder: the recording, the mic audio extract, the transcript, points, screenshots, the review draft.

### 2. Import
- Drop zone + file picker. Shows: filename, duration, resolution, audio tracks found (which one is the mic).
- Mic-track picker when OBS gave multiple tracks; sensible default (the mic track) pre-selected.
- "Transcribe" button. Nothing else on this screen.

### 3. Transcribe
- Progress bar + status (extracting audio → uploading → transcribing → done).
- On completion: transcript stats (word count, duration, cost of this run shown in cents).
- Failure state: plain error, retry button, audio file kept so nothing is lost.

### 4. Scrub & point (the main screen)
- Left: video player with transport (play/pause, ±5s, speed), current timecode, screenshot button (grabs the current frame into the active point). Clicking a transcript line seeks with `currentTime=word.start` and waits for `seeked`; highlight follows via `requestVideoFrameCallback`, not `timeupdate`. Captures default to canvas `drawImage`→`toBlob` JPEG 0.85; Mediabunny frame decode as fallback/batch.
- Right: transcript, each line timestamped and clickable — click jumps the video. Lines already pinned as points are marked.
- Bottom: the point composer — the pinned line's quote, a text field for the point itself, a bucket picker, save.
- Buckets (full mode, 14): Overview/Hook, Character, Controls, Camera, Game Feel/Juice, Gameplay Systems, Level Design/Difficulty/Pacing, Graphical Presentation, Audio Presentation, Story/Writing, Performance/Technical, Length/Value/Replay, Context, Verdict.
- Rapid mode (demo-day) collapses to 6: Overview, Feel (3Cs + juice), Systems, Graphics, Audio, Verdict.
- Points list: filter by bucket, jump back to any point's timestamp, delete/edit.

### 5. Assemble
- Segmented editor: one section per bucket that has points. Each section shows its points (quote + timestamp + screenshot) with a prose field above them.
- Live preview of the styled page (HG101/GameFAQs idiom + Neocities charm: ASCII-ish headers, numbered sections, plain readable type, hand-built retro-web touches — tiled backgrounds, pixel fonts, buttons/badges, a personal homepage feel).
- Review settings per game: full mode vs rapid mode, verdict wording, who-it's-for line.

### 6. Publish
- Cloudflare Pages export: uploads the finished page (and its screenshots) via the direct-upload API; or saves the files for manual upload — TBD, see open details.
- Itch comment generator: produces the paste-ready summary (hook + one-line verdict + link), copy button. Nothing is posted automatically, ever.

### Compress-clip button (planned, 2026-11-08 ~15:33 CST)
- A button on the Scrub & point screen, used during collection: take a clip and run the Compression Protocol presets on it (same Mediabunny engine as Clip Sizer — no new transcoder, the presets port over).
- Outputs: Discord MP4 (game audio, H264 AAC, under the Discord cap) + muted 4chan WebM (VP9, under the 4MB cap) + Socials pack as the "etc". Same targets/caps as Clip Sizer.
- Clip source: the time you set — scrub to the moment, mark the in/out range, hit the button. It spits out the 4chan WebM + Discord clip from that range.
- Loop unit U6, after U2 — it needs the scrubber and a marked clip to operate on.

## Data model

- **Session:** one game. Fields: game title, event (e.g. demo day), recording path, date, mode (full/rapid).
- **Transcript:** Deepgram response stored as JSON + plain text; segments with start/end times; word-level timings kept for scrub precision.
- **Point:** id, bucket, transcript line + timestamp, author text, optional screenshot path, created order.
- **Review:** assembled segments (bucket → prose + points), verdict, who-it's-for, publish state (draft / exported / published), Itch comment text.
- **Library:** all sessions, searchable by game/event.

## Tech

- **Tauri** (locked 2026-11-08 ~15:28 CST): Rust shell + TypeScript frontend, system webview, one codebase, web UI, native file access via real paths. Keyring crate → OS keychain for API keys. No FFmpeg sidecar (recording removed; media work is Mediabunny). No bundled Chromium.
- **Mediabunny:** mic-track extraction (downmix to mono), MKV→MP4 remux if the webview needs it, frame decode for screenshots. In-webview via WebCodecs, pulled newest on boot (same as Clip Sizer). No FFmpeg anywhere in the app.
- **Deepgram** (model-configurable, Nova-3 default): transcription, word-level timestamps. API key stored locally (see open details).
- **Cloudflare Pages:** review hosting. Export uploads HTML + screenshots via the direct-upload API.
- **Local-first:** sessions, transcripts, points, and screenshots live on his machine. The only network calls are Deepgram (audio upload) and the Cloudflare Pages upload.

## Deliberately NOT in the app

- No screen/game recorder — record in OBS with the bundled Review App profile (ruled 2026-11-08 ~12:39 CST).
- No auto-posting to Itch (paste-ready text only).
- No game-audio transcription (mic only).
- No scores in rapid mode (per the research: hook + one mechanic + feel + verdict, no scores).
- No cloud account, no sync, no server.

## Cost at his volume

Deepgram at ~$0.0043/min (Nova-3 default; verify in Console — Nova-2's prerecorded price is no longer in the main pricing table). A demo day of ten 15-minute clips = 150 min ≈ **$0.65**, and the $200 signup credit covers roughly 300 such demo days. Transcription cost is a non-issue at this scale.

## Open details (not rulings — decide when they matter)

- **App name.** "Review App" is the working title.
- **3Cs: confirmed** Character/Controls/Camera (2026-11-08 ~12:08 CST). The pipeline sorts points into the 3Cs among the other buckets.
- **API key storage (Deepgram, Cloudflare, Gemini draft):** OS keychain via the Tauri keyring crate (decided with the Tauri lock). Keys never live in plain config files.
- **OBS track layout:** which track is the mic depends on his OBS setup — the app should remember his track choice per setup, not ask every time.
- **Cloudflare Pages project:** which project hosts the reviews, and whether the app uploads directly or exports files for manual upload. API token storage alongside the Deepgram key.
- **Local-Whisper fallback:** faster-whisper on his machine as a $0, no-upload option later. Not the first build.
- **Electrobun prototype risks (verify first):** (a) dropped files have no `.path` in system webviews — the import flow must get a real filesystem path for a multi-GB OBS file (a file-open dialog returning a path, not FileReader-over-RPC, which would mean reading the whole file into memory); (b) WebView2 runtime present (preinstalled on Win 11, bundled/installed on Win 10); (c) no `saveFileDialog()` — exports write to known paths. (FFmpeg-spawn risk retired 2026-11-08: no FFmpeg in the app anymore.)
- **OBS profile install check:** the profile + scene collection are written from OBS's documented formats but haven't been import-tested in a live OBS yet — first import on his machine is the verification (game capture picks up a fullscreen game, mic lands on track 2, file lands in Videos as MKV).

## Build order (proposed)

1. Prototype the core loop first, in the chosen shell: import the MKV (recorded with the Review App OBS profile) → Mediabunny extracts the mic track → Deepgram → transcript + video scrubber that jumps to clicked lines. Prove the file-path question first (see open details).
2. Then points + buckets + screenshots.
3. Then assemble + styled preview.
4. Then Cloudflare Pages export + Itch comment generator.
5. Library / demo-day queue last (it only matters once multiple games exist).
6. Compress-clip button (after U2 — needs the scrubber + a marked clip range): Discord MP4 + muted 4chan WebM via the Compression Protocol presets.
