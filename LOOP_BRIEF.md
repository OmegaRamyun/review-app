# Brief: Review App — bootstrap the repo, scaffold the Tauri app, build + launch the loop

## RE-DISPATCH NOTE (2026-11-08 ~15:43 CST) — read first
A previous run of this exact brief died ~11 minutes in when the VM was replaced. The partial work is ON DISK — do not start from scratch and do not assume it is complete. VERIFY then REPAIR:
- Scaffold exists: `package.json` (review-app 0.1.0, Tauri 2.12.4, mediabunny 1.65.2, vite 8), `src/`, `src-tauri/`, `node_modules/`, `dist/` built 21:40. Verify the Tauri scaffold actually builds (`cargo tauri build` or a dev smoke) — repair whatever is broken, do not rebuild from zero.
- `loop/conductor.sh` exists (7,022 B) but is INCOMPLETE: `loop/launch.sh` (referenced by conductor.sh) is missing, `loop/queue.seed.json` and `loop/state/` do not exist, `ops/check.sh` is missing. Finish those.
- `ops/env.sh` and `ops/setup-toolchain.sh` exist — verify, use, repair as needed.
- NO `.git`, NO GitHub repo yet (`gh repo view OmegaRamyun/review-app` → "Could not resolve to a Repository"). Repo creation is still to do.
- The result file is empty — you will write it.
- Queue seed is now U1–U6 (U6 = the compress-clip button, added to DESIGN.md after the first brief — see step 4).

## What this is
Cade's desktop game-review app (Windows). Design source of truth: `/home/hatch/workspace/review-app/DESIGN.md` — READ IT FIRST, fully. It locks the platform (Windows desktop), the pipeline (OBS MKV import → Mediabunny mic-track extract → Deepgram transcribe → scrubber + points/buckets → assemble → Cloudflare Pages publish → paste-ready Itch comment), and the deliberately-NOT-in list (no in-app recorder, no auto-post, no game-audio transcription, no scores in rapid mode, no cloud account/sync/server, no FFmpeg anywhere). Those rulings are binding — do not re-litigate them.

Two newer rulings (in DESIGN.md as of today, 2026-11-08):
- **Shell is Tauri** (locked for the loop start; overturnable by Cade in one line, but do not re-litigate it in this bootstrap). Rust shell + TypeScript frontend, system webview via WebView2, keyring crate → OS keychain for API keys (Deepgram + Cloudflare + Gemini), drag-drop events hand the backend real absolute paths. Supersedes Electrobun.
- **AI draft is allowed**: the Assemble stage MAY use AI to turn the buckets/points into a coherent review draft. Draft only — the user edits it, nothing auto-publishes. Default provider: Gemini API (key in the OS keychain). The loop settles the exact model/key flow in the Assemble unit, not in this bootstrap.

WARNING: the build-research page/artifact (`review-app-build-research`) is STALE — it still says Electrobun and describes an FFmpeg sidecar. DESIGN.md wins wherever they disagree. The craft research (`game-review-research` page + `~/workspace/research_notes/game-review-structure-research-20261108-0652/report.md`) is still current: 14-bucket taxonomy, HG101 house rules, GameFAQs anatomy.

## Your job (lead; you are the only editor of the repo during this bootstrap)
You may fan out SPEC/VERIFY work to subagents, but all repo edits go through you.

1. **Create the repo.** `/home/hatch/workspace/review-app/` is not a git repo yet (it holds DESIGN.md + obs-profile/ — commit those too). `git init`, main branch, `gh repo create review-app --public` (gh auth as builder is verified: account CaCollinson64, `repo` scope — `gh repo create` will work), push main. Repo name is the working title; the app name is still open and the repo can be renamed later.
2. **Scaffold the Tauri app** per DESIGN.md (TypeScript frontend, Mediabunny for media, Deepgram for transcription). Keep it lean and clean — KISS. No feature creep, no new dependency without a need stated in DESIGN.md.
3. **Build the loop.** Adapt the existing loop machinery — READ these first: `/home/hatch/workspace/signal-protocol-ops/conductor.sh`, `conductor-launch.sh`, `run-loop-polish.sh`, `run-loop.sh`. Give the review app its own loop under `~/workspace/review-app/` (own queue file, own log, own launcher; single-instance-safe via flock; launched with setsid nohup so it survives the exec session that spawned it). The loop reads one unit at a time, dispatches Opus (code/systems) or Gemini (content/copy) by unit type, commits + pushes to GitHub per completed unit, and repeats. Do NOT build a new orchestration framework — adapt the proven scripts minimally. Do NOT point the Signal Protocol conductor at this repo; this loop is separate, with its own queue and log. Never push to itch (this app has no itch project); never publish reviews (that is the app user's action, not the loop's).
4. **Seed the queue** with the build-order units from DESIGN.md:
   - U1: prototype the core loop in Tauri — import an MKV (drag-drop) → Mediabunny extracts the mic track → Deepgram → transcript + video scrubber that jumps to clicked lines. PROVE THE FILE-PATH QUESTION FIRST: drag-drop must yield a real absolute path for a multi-GB OBS file (no FileReader-over-RPC whole-file-in-memory path).
   - U2: points + buckets (14 full / 6 rapid) + screenshots from the scrubber.
   - U3: assemble + styled preview (HG101/GameFAQs idiom + Neocities charm) + AI draft (Gemini).
   - U4: publish — Cloudflare Pages direct upload + Itch comment generator (paste-ready only).
   - U5: Library / demo-day queue last.
   - U6 (added 2026-11-08 ~15:33 CST, after the scrubber): compress-clip button on the Scrub & point screen — the time you set (marked in/out range), hit the button, it runs the Compression Protocol presets (same Mediabunny engine as Clip Sizer) and spits out a Discord MP4 (game audio) + muted 4chan WebM (+ Socials pack).
5. **Toolchain.** Verify Rust + Node work in this environment; install what's missing via the standard installers (rustup, node) under builder's home. Record the setup in a script (e.g. `review-app/ops/setup-toolchain.sh`) so it can be re-run after a VM replacement — only /home/hatch persists; /home/builder is wiped on VM swaps, so anything installed outside ~ must be reinstallable from the script.
6. **Test media.** If no OBS MKV with the profile's track layout (Track 1 = game, Track 2 = mic) exists on this machine, generate a small test MKV with 2 audio tracks, or document exactly what recording the loop needs from Cade.
7. **Launch the loop** and verify it is alive (exactly one loop process, queue file + log exist, first unit started or queued).

## Verification (report evidence, not claims)
- `gh repo view OmegaRamyun/review-app` (or the URL it reports) shows the repo; main is pushed; DESIGN.md + obs-profile/ are committed.
- The Tauri scaffold compiles (a real `cargo tauri build` or dev smoke — report the actual command + result, not "should work").
- The loop process is alive and single-instance; queue holds U1–U5; log shows the launch.
- Report anything blocked (toolchain install failure, gh failure, missing test media) with the exact error.

Keep the run under ~25 minutes of expected work. If it runs long, write the result file with partial progress and stop cleanly.

## Result
Write `/home/hatch/workspace/review-app/loop-bootstrap-opus-result.md` (pre-created, writable): repo URL, what was scaffolded, loop status (process, queue, log paths), the verification evidence above, and anything blocked or left open. Do not modify anything outside `~/workspace/review-app/`.
