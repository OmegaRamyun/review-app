#!/bin/bash
# conductor.sh — build loop for the Review App.
# Minimal adaptation of signal-protocol-ops/conductor.sh: same queue shape,
# same serial dispatch, EXIT trap, fail breaker, STOP file, audit triple and
# KEEP_BASE. Differences: no Jev routing — the unit's "type" picks the model
# (code -> opus, content -> gemini); the gate is ops/check.sh; every completed
# unit is committed AND pushed to GitHub (origin main).
#
# Never pushes to itch (this app has none). Never publishes reviews.
#
# Queue: loop/state/queue.json (seeded from loop/queue.seed.json)
#   {"units":[{"id","type":"code|content","status":"queued|in-progress|done|failed|future",
#              "files":"...","brief":"...","result":null}]}
# Stop:  touch loop/state/STOP     Status: loop/launch.sh --status

set -u
ROOT="/home/hatch/workspace/review-app"
STATE="$ROOT/loop/state"
cd "$ROOT" || exit 1

QUEUE="$STATE/queue.json"
LOG="$STATE/conductor.log"
STOP_FILE="$STATE/STOP"
PARKED_MARKER="$STATE/PARKED"
FAIL_COUNT_FILE="$STATE/.fail-count"
FAIL_BREAK_LIMIT="${FAIL_BREAK_LIMIT:-3}"
IDLE_SLEEP="${IDLE_SLEEP:-120}"
DISPATCH_TIMEOUT="${DISPATCH_TIMEOUT:-3600}"
AGY="/home/hatch/.local/bin/agy"

ts() { TZ=America/Chicago date +"%F %H:%M:%S CST"; }
trap 'echo "CONDUCTOR EXIT trap: code=$? at $(ts)" >> "$LOG"' EXIT
mkdir -p "$STATE/audit"
echo "=== review-app conductor started at $(ts) (user=$(id -un) pid=$$) ===" | tee -a "$LOG"
[ -f "$PARKED_MARKER" ] && rm -f "$PARKED_MARKER"
[ -f "$FAIL_COUNT_FILE" ] || echo 0 > "$FAIL_COUNT_FILE"
[ -f "$QUEUE" ] || cp "$ROOT/loop/queue.seed.json" "$QUEUE"

queue_next() { jq -r '[.units[] | select(.status=="queued")][0].id // empty' "$QUEUE" 2>/dev/null; }
queue_get()  { jq -r --arg id "$1" --arg f "$2" '.units[] | select(.id==$id) | .[$f] // ""' "$QUEUE" 2>/dev/null; }
queue_set()  { # $1=id $2=status $3=result — write in place (keeps owner/perms)
  local tmp="$QUEUE.tmp.$$"
  jq --arg id "$1" --arg st "$2" --arg rs "${3:-}" \
    '(.units[] | select(.id==$id)) |= (.status=$st | .result=(if $rs=="" then null else $rs end))' \
    "$QUEUE" > "$tmp" && cat "$tmp" > "$QUEUE"; rm -f "$tmp"
}

dispatch_unit() { # $1=id $2=model $3=brief $4=files
  local id="$1" model="$2" brief="$3" files="$4" audit="$STATE/audit/$1" pf rc=0 t0
  mkdir -p "$audit"; pf="$audit/mission.md"
  {
    echo "You are building the Review App: a Windows desktop game-review app (Tauri: Rust shell + TypeScript frontend)."
    echo "Working directory: $ROOT (the git repo). READ DESIGN.md FIRST, fully — it is the source of truth and its rulings are binding."
    echo "Binding rulings (do not re-litigate): no in-app recorder; no auto-post to Itch; mic-track-only transcription; no scores in rapid mode;"
    echo "no cloud account/sync/server; NO FFmpeg anywhere (media work is Mediabunny in the webview); API keys only in the OS keychain (keyring crate)."
    echo "KISS: no new dependency unless DESIGN.md states the need. No feature creep beyond this unit."
    echo ""
    echo "Work unit [$id]: $brief"
    echo ""
    echo "EDITABLE SURFACE: ${files:-the app source (src/, src-tauri/, index.html, package.json)}. Do not touch loop/, ops/, DESIGN.md or obs-profile/."
    echo "Toolchain: 'source ops/env.sh' first (cargo, npm, webkit sysroot). This box is Linux; the target is Windows/WebView2 —"
    echo "Linux webkit2gtk is only the compile gate. Note anything that needs verification on Cade's Windows machine in NOTES.md (create if absent)."
    echo "Before finishing, run 'bash ops/check.sh' and make it pass (typecheck + frontend build + cargo build)."
    echo "Do not commit or push — the conductor commits and pushes. End with a short report of what changed and what Cade must verify on Windows."
    echo "If the unit's goal is already met, make no changes and end with NO_CHANGE on its own line."
    echo "Parallelize independent tracks with subagents rather than grinding everything in one context."
  } > "$pf"
  chmod 644 "$pf"
  t0=$(date +%s)
  case "$model" in
    opus)
      ( source ~/.claude_oauth_env && cd "$ROOT" && timeout "$DISPATCH_TIMEOUT" /usr/bin/claude -p --model opus \
          --dangerously-skip-permissions "$(cat "$pf")" </dev/null ) > "$audit/response.log" 2>&1
      rc=$? ;;
    gemini)
      ( cd "$ROOT" && timeout "$DISPATCH_TIMEOUT" "$AGY" --dangerously-skip-permissions --print="$(cat "$pf")" </dev/null ) \
          > "$audit/response.log" 2>&1
      rc=$? ;;
    *) rc=1 ;;
  esac
  printf '{"id":"%s","model":"%s","exit":%d,"started":%d,"ended":%d}\n' "$id" "$model" "$rc" "$t0" "$(date +%s)" > "$audit/meta.json"
  tail -3 "$audit/response.log" | tee -a "$LOG"
  return $rc
}

while [ ! -f "$STOP_FILE" ]; do
  id="$(queue_next)"
  if [ -z "$id" ]; then sleep "$IDLE_SLEEP"; continue; fi
  brief="$(queue_get "$id" brief)"; files="$(queue_get "$id" files)"; type="$(queue_get "$id" type)"
  case "$type" in content) model=gemini ;; *) model=opus ;; esac
  echo "=== unit $id ($type -> $model) at $(ts) ===" | tee -a "$LOG"
  queue_set "$id" "in-progress"

  if dispatch_unit "$id" "$model" "$brief" "$files"; then
    if bash ops/check.sh > "$STATE/audit/$id/check.log" 2>&1; then
      if [ -z "$(git status --porcelain)" ]; then
        echo "conductor: no diff for $id — KEEP_BASE" | tee -a "$LOG"
        queue_set "$id" "done" "model=$model no-change (KEEP_BASE)"
      else
        msg="$STATE/audit/$id/commit-msg.txt"
        printf 'loop[%s] (%s)\n\n%s\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' "$id" "$model" "$brief" > "$msg"
        git add -A && git commit -q -F "$msg" 2>&1 | tail -1 | tee -a "$LOG"
        if git push -q origin main >> "$LOG" 2>&1; then push="pushed $(git rev-parse --short HEAD)"; else push="PUSH FAILED (committed locally)"; fi
        echo "conductor: $id committed, $push" | tee -a "$LOG"
        queue_set "$id" "done" "model=$model $push"
      fi
      echo 0 > "$FAIL_COUNT_FILE"
    else
      echo "conductor: check FAILED for $id — see $STATE/audit/$id/check.log; tree left dirty for inspection" | tee -a "$LOG"
      queue_set "$id" "failed" "check failed"
      echo $(( $(cat "$FAIL_COUNT_FILE") + 1 )) > "$FAIL_COUNT_FILE"
      # A dirty failed tree would be swept into the next unit's commit: park instead.
      echo "parked: $id failed its check at $(ts)" > "$PARKED_MARKER"; exit 1
    fi
  else
    echo "conductor: dispatch FAILED for $id ($model) rc=$?" | tee -a "$LOG"
    queue_set "$id" "failed" "dispatch failed model=$model"
    echo $(( $(cat "$FAIL_COUNT_FILE") + 1 )) > "$FAIL_COUNT_FILE"
    if [ -n "$(git status --porcelain)" ]; then
      echo "parked: $id dispatch failed with a dirty tree at $(ts)" > "$PARKED_MARKER"; exit 1
    fi
  fi

  if [ "$(cat "$FAIL_COUNT_FILE")" -ge "$FAIL_BREAK_LIMIT" ]; then
    echo "conductor: $FAIL_BREAK_LIMIT consecutive failures — parking at $(ts)" | tee -a "$LOG"
    echo "parked: consecutive failures at $(ts)" > "$PARKED_MARKER"; exit 1
  fi
done
echo "conductor: STOP present — exiting" | tee -a "$LOG"
