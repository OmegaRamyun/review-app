# Review App loop bootstrap — result (2026-11-08 ~16:10 CST)

Status: **DONE.** Repo created and pushed, scaffold compiles (tauri release build), loop live on U1. One open item: the Linux launch smoke is blocked (needs root). See "Blocked / open".

## Repo
- https://github.com/OmegaRamyun/review-app (PUBLIC, default branch `main`). `gh` created it under **OmegaRamyun** even though the brief said "account CaCollinson64". Worth checking which login is active.
- Bootstrap commit `b010f01` (35 files): DESIGN.md, obs-profile/ (README, `Review App/`, `Review App.json`), LOOP_BRIEF.md, scaffold, ops/, loop/, test-media/.
  `git ls-remote origin main` → `b010f017fb7abd2003b1bfb7d60a52be2c7ba920 refs/heads/main`.

## Scaffold (verified and repaired, not rebuilt)
- Tauri 2 + TS/Vite frontend (`src/main.ts`: `onDragDropEvent` → absolute paths → Rust `stat_file` returns metadata only and never reads the file). Deps are unchanged: @tauri-apps/api, mediabunny, vite, typescript. The keyring crate is NOT added yet. U1 adds it when it stores the Deepgram key.
- Repairs:
  1. Rust had been wiped by the VM swap. It is now installed **under the repo** (`.toolchain/rustup`, `.toolchain/cargo`, inside /home/hatch) so it survives future swaps. `env.sh` and `setup-toolchain.sh` are updated to match.
  2. crates.io from this box is slow (the first fetch died with "transfer too slow"). `env.sh` now sets longer cargo HTTP timeouts and retries.
  3. The link failed with `rust-lld: unable to find library -lgtk-3 / -latk-1.0 / -lgdk-3 / -lgdk_pixbuf-2.0`. The cause was dev `.so` symlinks in the sysroot pointing at runtime libs that live only in the image's /usr/lib (30 dangling links). They are now re-pointed, and `setup-toolchain.sh` repeats that fix on every run.
  4. Wrote `ops/check.sh`, the loop gate: `npm run build` (tsc + vite) followed by `cargo build`. The exit code is the verdict.
- Evidence:
  - `bash ops/check.sh` → `check OK`, rc=0.
  - `npx tauri build --no-bundle` (with ops/env.sh sourced) → rc=0, "Finished `release` profile in 7m 27s", binary at `src-tauri/target/release/review-app` (7.1 MB).
  - `--no-bundle` was needed because the configured bundle target is `nsis` (Windows).

## Loop
- Files:
  - `loop/conductor.sh`: adapted from signal-protocol-ops/conductor.sh. Unit `type` picks the model (code→opus, content→gemini). The gate is ops/check.sh. KEEP_BASE on no diff. Each unit gets an audit dir with mission, response, meta and check logs. Commits with `-F`, then `git push origin main` per unit. EXIT trap, 3-failure breaker, and it parks on a dirty failed tree. Never touches itch and never publishes.
  - `loop/launch.sh`: adapted from conductor-launch.sh. flock -n single instance, setsid nohup, absolute SELF, `--status`.
  - `loop/queue.seed.json`: U1–U6, all `code`, in DESIGN order. U6 comes last, which satisfies "after U2", and points at /home/hatch/workspace/clip-sizer read-only for the presets.
- Runtime state (gitignored): `loop/state/queue.json`, `loop/state/conductor.log`, `loop/state/audit/<id>/`, `loop/state/.conductor.lock`. Stop with `touch loop/state/STOP`.
- Live at 16:08:51 CST:
  - flock 16987 → `/bin/bash .../review-app/loop/conductor.sh` 16992 → dispatch subshell 17016 → `timeout 3600 /usr/bin/claude -p --model opus ...` 17018. That is one instance, healthy-busy.
  - `loop/launch.sh --status` → RUNNING; U1 in-progress, U2–U6 queued.
  - conductor.log: `=== review-app conductor started at 2026-11-08 16:08:51 CST (user=builder pid=16992) ===` / `=== unit U1 (code -> opus) ... ===`.
  - The Signal Protocol conductor (pid 2276, its own lock) was left alone.
- Counting note: `pgrep -c -f "[c]onductor.sh"` also matches the Signal Protocol conductor. For this loop, count `pgrep -f "review-app/loop/conductor.sh"` instead: expect 2 when idle, 3 when busy.

## Toolchain
- `ops/setup-toolchain.sh` is idempotent and needs no root: rustup into .toolchain, node from the image (npm at /opt/hatch-image/bin), a user-space webkit2gtk-4.1-dev sysroot, the symlink repair, then npm install. Use the result with `source ops/env.sh`.

## Test media
- `test-media/obs-layout-test.mkv` (928 KB, 20 s, 1280x720 30fps H.264, Track 1 = stereo tone "game", Track 2 = mono flite TTS speech "mic") is committed. It was made with system ffmpeg as a fixture only. The regen command is in test-media/README.md.
- Still needed from Cade for the Windows sign-off of U1: one real 1–5 min recording made with the OBS profile, and one multi-GB long recording for the big-file drag-drop proof.

## Blocked / open
- **Linux launch smoke is blocked.** `xvfb-run -a src-tauri/target/release/review-app` aborts with `Unable to spawn ... "/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitNetworkProcess" (No such file or directory)`. The user-space sysroot has the helper, but the distro WebKit hardcodes the /usr path, and `WEBKIT_EXEC_PATH` did not override it. Fixing it needs a root turn (install `libwebkit2gtk-4.1-0`, or symlink `/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1` → the sysroot dir). This does not block the loop, whose gate is compile-only. Runtime behaviour (WebView2) has to be verified on Cade's Windows machine anyway.
- No Deepgram, Cloudflare or Gemini keys exist on this box. Units are briefed to make those paths testable and to list the Windows steps in NOTES.md.
- U1 is a big unit and the dispatch timeout is 3600 s. If it times out, the conductor parks on the dirty tree for inspection rather than sweeping it into U2.
- App name is still open. The repo can be renamed later.
