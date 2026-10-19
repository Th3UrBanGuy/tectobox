#!/bin/bash
# nightly-garbage-clean.sh — daily 02:00 +06 trash cleanup for the Tectobox VM.
# Keeps the system lean and load-free: trims fat logs, clears caches, sweeps
# stale /tmp. Runs in seconds, almost no CPU.
#
# NEVER touches: live pidfiles/sockets, docker images/containers, node_modules,
# tectonic-ssh.tar / build-rootfs (VM-reboot recovery assets), the sqlite DB.
set -u
HIDDEN=~/workspace/goals/tectonic-inbox-hosting/hidden_files
LOG="$HIDDEN/clean-log.txt"
mkdir -p "$HIDDEN" 2>/dev/null
BEFORE=$(df -k / 2>/dev/null | tail -1 | awk '{print $3}')

# 1. fat logs — copy-truncate (owners hold the fd open; never mv these)
trunc() { # $1=file $2=keep-lines
  [ -f "$1" ] || return 0
  tail -n "$2" "$1" >"$1.tmp" 2>/dev/null && cat "$1.tmp" >"$1" && rm -f "$1.tmp"
}
trunc ~/workspace/tectonic-inbox/server.log 500
trunc ~/workspace/tectonic-inbox/monitor.log 500
for f in ~/workspace/porter/tunnel-replica.log \
         ~/workspace/porter/tunnel-replica-b.log \
         ~/workspace/porter/tunnel-replica-c.log \
         ~/workspace/porter/edge-relay.log; do
  trunc "$f" 300
done

# 2. self-report events — newest 200 (writers use >>, mv-rotate is safe)
EV="$HIDDEN/monitor-events.log"
if [ -f "$EV" ] && [ "$(wc -l <"$EV" 2>/dev/null || echo 0)" -gt 200 ]; then
  tail -n 200 "$EV" >"$EV.tmp" && mv "$EV.tmp" "$EV"
fi

# 3. /tmp + /var/tmp — files untouched for 3+ days, but NEVER pidfiles,
#    sockets, or the live tectonic/unified markers
find /tmp /var/tmp -maxdepth 1 -type f -atime +3 \
  ! -name "*.pid" ! -name "*.sock" \
  ! -name "tectonic-*" ! -name "unified-*" \
  -delete 2>/dev/null

# 4. npm download cache — pure cache, always safe to drop
npm cache clean --force >/dev/null 2>&1 || true

# 5. rotated leftovers older than a week
find ~/workspace/porter ~/workspace/tectonic-inbox -maxdepth 1 \
  -name "*.log.*" -mtime +7 -delete 2>/dev/null

AFTER=$(df -k / 2>/dev/null | tail -1 | awk '{print $3}')
FREED_MB=$(( (BEFORE - AFTER) / 1024 ))
[ "$FREED_MB" -lt 0 ] && FREED_MB=0
echo "[$(date -u +%FT%TZ)] nightly clean done — ~${FREED_MB}MB freed" >>"$LOG"
echo "FREED_MB=$FREED_MB"
