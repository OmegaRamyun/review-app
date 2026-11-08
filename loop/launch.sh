#!/usr/bin/env bash
# Single-instance launcher for the Review App conductor.
# Adapted from signal-protocol-ops/conductor-launch.sh: non-blocking flock
# (a second launch exits cleanly), setsid nohup detach (survives the exec
# session that spawned it), absolute SELF path for the su hop.
#
#   loop/launch.sh            start (no-op if already running)
#   loop/launch.sh --status   RUNNING / STOPPED (exit 0 / 1) + queue summary
#   touch loop/state/STOP     stop after the current unit
set -u
ROOT="/home/hatch/workspace/review-app"
STATE="$ROOT/loop/state"
BUILDER_USER="${BUILDER_USER:-builder}"
LOCK_FILE="$STATE/.conductor.lock"
LOG_FILE="$STATE/conductor.log"
SELF="$(cd "$(dirname "$0")" >/dev/null 2>&1 && pwd)/$(basename "$0")"

run_as_builder() { # builder->builder su prompts for a password: skip it
  if [ "$(id -un)" = "$BUILDER_USER" ]; then "$@"
  else su -s /bin/bash "$BUILDER_USER" -c "$(printf '%q ' "$@")"; fi
}
lock_is_held() { ( flock -n 9 ) 9>>"$LOCK_FILE" 2>/dev/null && return 1 || return 0; }

case "${1:-start}" in
  --status)
    if [ -e "$LOCK_FILE" ] && lock_is_held; then echo "RUNNING"; r=0; else echo "STOPPED"; r=1; fi
    [ -f "$STATE/queue.json" ] && jq -r '.units[] | "  \(.id)\t\(.status)\t\(.result // "")"' "$STATE/queue.json"
    [ -f "$STATE/PARKED" ] && echo "  PARKED: $(cat "$STATE/PARKED")"
    exit $r ;;
  --inner)
    cd "$ROOT" || exit 1
    : >> "$LOCK_FILE"; chmod 666 "$LOCK_FILE" 2>/dev/null || true
    exec flock -n -o "$LOCK_FILE" "$ROOT/loop/conductor.sh" ;;
  --inner-as)
    run_as_builder "$SELF" --inner ;;
  start)
    mkdir -p "$STATE"
    if [ -e "$LOCK_FILE" ] && lock_is_held; then
      echo "$(date -u +%FT%TZ) launcher: conductor already running, refusing second launch" | tee -a "$LOG_FILE"; exit 0
    fi
    rm -f "$STATE/STOP"
    setsid nohup "$SELF" --inner-as </dev/null >/dev/null 2>&1 &
    echo "launched"; exit 0 ;;
  *) echo "usage: $0 [start|--status]" >&2; exit 2 ;;
esac
