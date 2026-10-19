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

# Structured self-report: every recovery action the loop takes is recorded
# here the instant it happens. The 1-minute fast-watch reads this file and
# surfaces new events to the user — so an outage is reported ~1 min after
# it is detected, along with what fixed it.
EVENTS=~/workspace/goals/tectonic-inbox-hosting/hidden_files/monitor-events.log
report_event() { # $1=type $2=detail
  mkdir -p "$(dirname "$EVENTS")" 2>/dev/null
  printf '{"ts":"%s","type":"%s","detail":"%s"}\n' "$(date -u +%FT%TZ)" "$1" "$2" >>"$EVENTS" 2>/dev/null
}

healthy() { curl -sf -m 5 http://127.0.0.1:3120/healthz >/dev/null 2>&1; }
public_healthy() { curl -sf -m 5 https://ss.kalandar.me/healthz >/dev/null 2>&1; }
port_open() { (echo > /dev/tcp/127.0.0.1/$1) 2>/dev/null; }
tunnel_replicas() { pgrep -f "cloudflared tunne[l]" 2>/dev/null | wc -l; }

restart_edge() {
  log "WARN: edge relay port(s) down — restarting edge stack"
  bash ~/workspace/porter/start-edge-stack.sh >/dev/null 2>&1 \
    && { log "edge relay restarted"; report_event "edge_restart" "relay port(s) down; edge stack restarted"; } \
    || log "ERROR: edge-relay starter failed"
}
restart_tunnel() { # $1=reason
  log "WARN: $1 — restarting tunnel stack"
  bash ~/workspace/porter/start-tunnel-stack.sh >/dev/null 2>&1 \
    && { log "tunnel stack restarted (3 replicas)"; report_event "tunnel_restart" "$1; tunnel stack restarted"; } \
    || log "ERROR: tunnel starter failed"
}

start_node() {
  load_proxy_env
  # Kill strays first (draining nodes can fake-healthy on /healthz).
  # PORT-scoped: never touch a test/dev server on another port (e.g. :3121).
  for pid in $(pgrep -f "node server.j[s]" 2>/dev/null); do
    if tr '\0' '\n' < /proc/$pid/environ 2>/dev/null | grep -q "^PORT=3120$"; then
      kill "$pid" 2>/dev/null
    fi
  done
  for _ in $(seq 1 15); do
    still=0
    for pid in $(pgrep -f "node server.j[s]" 2>/dev/null); do
      if tr '\0' '\n' < /proc/$pid/environ 2>/dev/null | grep -q "^PORT=3120$"; then still=1; break; fi
    done
    [ "$still" = "0" ] && break
    sleep 1
  done
  for pid in $(pgrep -f "node server.j[s]" 2>/dev/null); do
    if tr '\0' '\n' < /proc/$pid/environ 2>/dev/null | grep -q "^PORT=3120$"; then
      kill -9 "$pid" 2>/dev/null
    fi
  done
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
  # self-report events: keep the newest 200, drop the rest (writers use >>,
  # so an mv-rotate never loses an event)
  if [ -f "$EVENTS" ]; then
    lines=$(wc -l <"$EVENTS" 2>/dev/null || echo 0)
    if [ "$lines" -gt 200 ]; then
      tail -n 200 "$EVENTS" >"$EVENTS.tmp" && mv "$EVENTS.tmp" "$EVENTS"
    fi
  fi
  # app + tunnel logs: the processes hold these files open, so never mv them
  # (that would orphan their fd) — copy-truncate back into the same inode.
  local f sz
  for f in server.log; do
    if [ -f "$f" ]; then
      sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
      if [ "$sz" -gt 2097152 ]; then
        tail -n 800 "$f" >"$f.tmp" && cat "$f.tmp" >"$f" && rm -f "$f.tmp"
      fi
    fi
  done
  for f in ~/workspace/porter/tunnel-replica.log ~/workspace/porter/tunnel-replica-b.log ~/workspace/porter/tunnel-replica-c.log; do
    if [ -f "$f" ]; then
      sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
      if [ "$sz" -gt 1048576 ]; then
        tail -n 400 "$f" >"$f.tmp" && cat "$f.tmp" >"$f" && rm -f "$f.tmp"
      fi
    fi
  done
}

run_loop() {
  echo $$ >"$PIDFILE"
  log "monitor loop started (pid $$) — vm_boot: $(who -b 2>/dev/null | awk '{print $3, $4}' || echo unknown), uptime: $(awk '{print int($1)"s"}' /proc/uptime 2>/dev/null || echo unknown)"
  load_proxy_env  # public probes need the egress proxy in cron-spawned envs
  local fail=0 grace_until=0 tick=0 pub_fail=0
  while true; do
    tick=$((tick + 1))
    local now_s
    now_s=$(date +%s)
    # ---- :3120 guard (host node) ----
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
        report_event "node_restart" ":3120 unhealthy 2x; host node restarted"
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
    # ---- edge relay guard (every tick): one process, all-or-nothing ----
    if ! port_open 17844; then
      restart_edge
    fi
    # ---- tunnel + public guard (every 2nd tick ≈ 20s) ----
    # Budget: detect ≤20s + replica start ~4s + cloudflared registration ~25s
    # → public back in well under 60s.
    if [ $((tick % 2)) -eq 0 ]; then
      if public_healthy; then
        pub_fail=0
      else
        pub_fail=$((pub_fail + 1))
        local reps
        reps=$(tunnel_replicas)
        if [ "$reps" -eq 0 ]; then
          restart_tunnel "public unreachable + 0 tunnel replicas (attempt $pub_fail)"
          pub_fail=0
          sleep 25  # let cloudflared register before the next verdict
        elif [ "$pub_fail" -ge 3 ]; then
          # Replicas alive but public still dark ~60s: the VM→edge path is
          # wedged, not the replicas — nuking them can't help and only adds
          # re-registration delay. Log loudly; the 5-min supervisor + the
          # next fast-watch report pick it up for a human look.
          log "ERROR: public unreachable 3x with $reps replicas alive — edge path wedged, NOT restarting replicas"
          report_event "public_dark_replicas_alive" "public 530 ~60s with $reps replicas alive; needs human look"
          pub_fail=0
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
# Boot path: a fresh loop means the old one died — on a VM reboot/replacement
# the edge relay and tunnel replicas are gone too. The loop's per-tick guards
# recover them within ~30s, but kick them NOW (idempotent scripts) so the
# public site is back in well under 60s.
bash ~/workspace/porter/start-edge-stack.sh >/dev/null 2>&1 &
bash ~/workspace/porter/start-tunnel-stack.sh >/dev/null 2>&1 &
# Backstop: if :3120 is down RIGHT NOW, don't wait for the loop's first checks.
sleep 2
if ! healthy; then
  log "WARN: :3120 down at monitor start — emergency restart"
  start_node
fi
exit 0
