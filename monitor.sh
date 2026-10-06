#!/bin/bash
# monitor.sh — persistent 10-second guard for ss.kalandar.me (:3120).
#
# KIYAMOT-PROOF DESIGN (2026-10-01): :3120 is served ONLY by the host node.
# This loop keeps it alive: two consecutive failed /healthz checks →
# restart the host node. Worst-case detection+recovery is ~30s, independent
# of the 5-minute supervisor cron.
#
# Singleton via pidfile. Called with no args (e.g. from cron) it daemonizes
# itself and returns immediately; called with "_loop" it runs the loop.
#
# It never touches the container — container work is the 5-min supervisor's
# best-effort job and can never take :3120 down.
set -u
cd ~/workspace/tectonic-inbox
PIDFILE=/tmp/tectonic-monitor.pid
LOG=monitor.log

# Load egress proxy env (Baileys WhatsApp + several AI tiers need it; the
# container never sees host env, but THIS node runs on the host and needs
# the same vars the supervisor would pass with -e).
load_proxy_env() {
  if [ -f /etc/profile.d/hatch-egress.sh ]; then
    set -a; . /etc/profile.d/hatch-egress.sh 2>/dev/null; set +a
  fi
}

log() { echo "[$(date -u +%FT%TZ)] $*" >>"$LOG"; }

healthy() { curl -sf -m 5 http://127.0.0.1:3120/healthz >/dev/null 2>&1; }

start_node() {
  load_proxy_env
  # Kill strays first (draining nodes can fake-healthy on /healthz).
  for pid in $(pgrep -f "node server.j[s]" 2>/dev/null); do kill "$pid" 2>/dev/null; done
  for _ in $(seq 1 15); do
    pgrep -f "node server.j[s]" >/dev/null 2>&1 || break
    sleep 1
  done
  for pid in $(pgrep -f "node server.j[s]" 2>/dev/null); do kill -9 "$pid" 2>/dev/null; done
  NODE_ENV=production PORT=3120 nohup node server.js >>server.log 2>&1 &
  disown 2>/dev/null || true
  # Coordination stamp: the 5-min supervisor must not restart :3120 on top of
  # us (restart pairs = extended downtime). Both watchers honor this file.
  date +%s > /tmp/tectonic-last-restart 2>/dev/null || true
}

rotate_log() {
  # keep the log small: trim to last 500 lines once it passes 2000
  local lines
  lines=$(wc -l <"$LOG" 2>/dev/null || echo 0)
  if [ "$lines" -gt 2000 ]; then
    tail -n 500 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
}

run_loop() {
  echo $$ >"$PIDFILE"
  log "monitor loop started (pid $$) — vm_boot: $(who -b 2>/dev/null | awk '{print $3, $4}' || echo unknown), uptime: $(awk '{print int($1)"s"}' /proc/uptime 2>/dev/null || echo unknown)"
  local fail=0 grace_until=0
  while true; do
    local now_s
    now_s=$(date +%s)
    if healthy; then
      fail=0
    elif [ "$now_s" -lt "$grace_until" ]; then
      # Fresh restart still booting (connector restore ~15-30s) — don't
      # mistake startup for another outage.
      fail=0
    else
      fail=$((fail + 1))
      if [ "$fail" -ge 2 ]; then
        log "WARN: :3120 unhealthy twice in a row — restarting host node"
        start_node
        grace_until=$(( $(date +%s) + 60 ))
        sleep 10
        if healthy; then
          log "host node recovered on :3120"
          fail=0
        else
          log "ERROR: host node still unhealthy after restart — will keep retrying"
          fail=0  # avoid tight restart loop; next failures re-trigger after 20s
          sleep 30
        fi
      fi
    fi
    rotate_log
    sleep 10
  done
}

if [ "${1:-}" = "_loop" ]; then
  run_loop
  exit 0
fi

# Daemonize (cron-safe): singleton check, then detach.
if [ -f "$PIDFILE" ]; then
  oldpid=$(cat "$PIDFILE" 2>/dev/null || echo "")
  if [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null; then
    exit 0  # already running
  fi
fi
setsid nohup bash "$0" _loop >>"$LOG" 2>&1 < /dev/null &
disown 2>/dev/null || true
# Backstop: if :3120 is down RIGHT NOW, don't wait for the loop's first checks.
sleep 2
if ! healthy; then
  log "WARN: :3120 down at monitor start — emergency restart"
  start_node
fi
exit 0
