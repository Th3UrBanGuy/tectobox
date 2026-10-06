#!/bin/bash
# Tectonic stack supervisor — idempotent, safe to run on a schedule.
#
# ============================================================================
# KIYAMOT-PROOF ARCHITECTURE (2026-10-01)
# ----------------------------------------------------------------------------
# The #1 lesson from every outage: the old supervisor KILLED the healthy host
# node to start the container, then the container failed to come up → the
# site went down. That can never happen again:
#
#   * :3120 is served ONLY by the host node (NODE_ENV=production).
#     NOTHING in this script ever stops a healthy :3120.
#   * The "tectonic" container is a SIDECAR: sshd :2222 + OmniRoute :20128.
#     It never binds :3120 (drun --entrypoint /app/container-sidecar.sh).
#     Its health never affects the site.
#   * A persistent 10s monitor loop (monitor.sh) restarts the host node
#     within ~30s of any crash; this 5-min script is the heavy lifter
#     (edge relay, tunnel, container restore with timeouts).
#   * Every container operation is time-boxed and best-effort. If drun hangs,
#     dockerd is wedged, or the image is gone — the site stays up on the
#     host node and we retry next run.
# ============================================================================
# Run as root.
set -u
cd ~/workspace/tectonic-inbox

# ---- Singleton lock with PID-based stale detection ----
LOCKDIR=/tmp/tectonic-stack.lockdir
rm -f /tmp/tectonic-stack.lock  # legacy fd-lock file, no longer used
take_lock() {
  if mkdir "$LOCKDIR" 2>/dev/null; then
    echo $$ >"$LOCKDIR/pid"
    return 0
  fi
  local oldpid=""
  [ -f "$LOCKDIR/pid" ] && oldpid=$(cat "$LOCKDIR/pid" 2>/dev/null || true)
  if [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null; then
    return 1  # genuinely another run in progress
  fi
  # stale lock (crashed run or dead pid) — take over
  rm -rf "$LOCKDIR" 2>/dev/null
  if mkdir "$LOCKDIR" 2>/dev/null; then
    echo $$ >"$LOCKDIR/pid"
    return 0
  fi
  return 1
}
if ! take_lock; then
  echo "[$(date -u +%FT%TZ)] another supervisor run in progress, exiting"
  exit 0
fi
trap 'rm -rf "$LOCKDIR" 2>/dev/null' EXIT

log() { echo "[$(date -u +%FT%TZ)] $*"; }

healthy() { curl -sf -m 5 http://127.0.0.1:3120/healthz >/dev/null 2>&1; }

# Egress proxy env for anything started on the host (Baileys + AI tiers).
load_proxy_env() {
  if [ -z "${http_proxy:-}" ] && [ -f /etc/profile.d/hatch-egress.sh ]; then
    set -a; . /etc/profile.d/hatch-egress.sh 2>/dev/null; set +a
  fi
}

# Wait until all node server.js processes have actually exited. A SIGTERM'd
# node keeps answering /healthz while it drains, which used to fake a
# "healthy" poll right after a restart and leave nothing running.
wait_for_node_exit() {
  for _ in $(seq 1 15); do
    pgrep -f "node server.j[s]" >/dev/null 2>&1 || return 0
    sleep 1
  done
  for pid in $(pgrep -f "node server.j[s]" 2>/dev/null); do
    kill -9 "$pid" 2>/dev/null
  done
  sleep 1
  return 0
}

container_runtime_ready() {
  command -v drun >/dev/null 2>&1 \
    && command -v docker >/dev/null 2>&1 \
    && docker image inspect tectonic-ssh:latest >/dev/null 2>&1
}

container_running() {
  minirunc state tectonic 2>/dev/null | grep -q '"status": *"running"'
}

# ============================================================================
# STEP 1+2: edge relay + tunnel (unchanged)
# ============================================================================
bash ~/workspace/porter/start-edge-stack.sh >/dev/null 2>&1 || log "WARN: edge-relay starter failed"
bash ~/workspace/porter/start-tunnel-stack.sh >/dev/null 2>&1 || log "WARN: tunnel starter failed"

# STEP 2b: browser relay for the website importer (headless Chromium egress).
# The importer's browser-render.js auto-spawns this too, but the supervisor
# keeps it alive across restarts.
if ! (exec 3<>/dev/tcp/127.0.0.1/18080) 2>/dev/null; then
  log "starting browser egress relay on :18080"
  nohup node ~/workspace/tectonic-inbox/src/relay-for-browser.js >>/tmp/relay-browser.log 2>&1 &
else
  exec 3<&- 2>/dev/null; exec 3>&- 2>/dev/null
fi

# ============================================================================
# STEP 3: host node on :3120 — SACRED. Never stop a healthy one.
# ============================================================================
load_proxy_env
if healthy; then
  log "tectonic already healthy on :3120 (host node) — leaving it alone"
else
  # Don't pile onto a restart the 10s monitor just did — its node may still
  # be booting (connector restore takes ~15-30s). Restart pairs = downtime.
  if [ -f /tmp/tectonic-last-restart ]; then
    last_rs=$(cat /tmp/tectonic-last-restart 2>/dev/null || echo 0)
    if [ $(( $(date +%s) - last_rs )) -lt 120 ]; then
      log "tectonic restarted <120s ago by monitor — skipping supervisor restart"
      ok=1
    fi
  fi
  if [ "${ok:-0}" != "1" ]; then
  log "WARN: :3120 unhealthy — (re)starting host node"
  for pid in $(pgrep -f "node server.j[s]" 2>/dev/null); do
    kill "$pid" 2>/dev/null
  done
  wait_for_node_exit
  NODE_ENV=production PORT=3120 nohup node server.js >>server.log 2>&1 &
  disown 2>/dev/null || true
  ok=0
  for _ in $(seq 1 12); do
    sleep 5
    if healthy; then ok=1; break; fi
  done
  if [ "$ok" = "1" ]; then
    log "tectonic healthy on :3120 (host node)"
  else
    log "ERROR: host node failed to become healthy after 60s — monitor loop will keep retrying"
    # do NOT exit here: still attempt the sidecar below; the monitor retries :3120
  fi
  fi
fi

# Make sure the 10s monitor loop is alive (it is the real kiyamot-proofing).
bash ./monitor.sh >/dev/null 2>&1 || log "WARN: monitor starter failed"

# ============================================================================
# STEP 4: container sidecar (sshd :2222 + OmniRoute :20128) — BEST EFFORT.
# Never touches :3120 or the host node. Every operation is time-boxed.
# ============================================================================
omniroute_healthy() { curl -sf -m 5 http://127.0.0.1:20128/api/health >/dev/null 2>&1; }
ssh_healthy() { (echo >/dev/tcp/127.0.0.1/2222) >/dev/null 2>&1; }

start_sidecar_container() {
  # $1 = attempt number (for logging)
  log "starting sidecar container (attempt $1, 180s timeout)"
  # Detached stdio: the container init inherits our fds; captured pipes
  # would never EOF and hang the scheduler. setsid + /dev/null + log file.
  # --entrypoint overrides the image's baked entrypoint so the container
  # runs sshd+omniroute ONLY and never binds :3120.
  timeout 180 setsid drun -d --name tectonic --entrypoint /app/container-sidecar.sh \
    -e "https_proxy=${https_proxy:-}" -e "HTTPS_PROXY=${HTTPS_PROXY:-}" \
    -e "http_proxy=${http_proxy:-}" -e "HTTP_PROXY=${HTTP_PROXY:-}" \
    -e "no_proxy=${no_proxy:-}" -e "NO_PROXY=${NO_PROXY:-}" \
    -e "NODE_EXTRA_CA_CERTS=${NODE_EXTRA_CA_CERTS:-}" \
    -v /home/hatch/workspace/tectonic-inbox:/app \
    -v /home/hatch/.omniroute:/root/.omniroute \
    -v /home/hatch/workspace/omniroute:/opt/omniroute \
    -v /etc/resolv.conf:/etc/resolv.conf:ro \
    -v /etc/hosts:/etc/hosts:ro \
    -v /run/hatch/egress-tls:/run/hatch/egress-tls:ro \
    -w /app tectonic-ssh:latest </dev/null >>sidecar-drun.log 2>&1
  return $?
}

restart_dockerd_once() {
  log "WARN: attempting one dockerd restart (possible wedge)"
  pkill -f "dockerd --storage-driver=vf[s]" 2>/dev/null
  sleep 3
  pkill -9 -f "dockerd --storage-driver=vf[s]" 2>/dev/null
  sleep 2
  setsid nohup dockerd --storage-driver=vfs --iptables=false --bridge=none \
    --userland-proxy=false >>dockerd.log 2>&1 < /dev/null &
  disown 2>/dev/null || true
  for _ in $(seq 1 6); do
    sleep 5
    docker info >/dev/null 2>&1 && { log "dockerd recovered"; return 0; }
  done
  log "WARN: dockerd still not responding"
  return 1
}

ensure_sidecar() {
  if ! container_runtime_ready; then
    # Runtime wiped (typical after a VM replacement). Kick off the fully
    # automatic background rebuild; the site is already up on the host node.
    if [ ! -f ".rebuild-in-progress" ] && ! pgrep -f "rebuild-image\.s[h]" >/dev/null 2>&1; then
      log "WARN: container runtime unavailable — starting automatic background rebuild (site stays up on host node)"
      setsid nohup bash ./rebuild-image.sh >>rebuild-image.log 2>&1 < /dev/null &
      disown 2>/dev/null || true
    else
      log "container runtime unavailable — rebuild already in progress (site stays up on host node)"
    fi
    return 0
  fi

  if container_running; then
    if omniroute_healthy && ssh_healthy; then
      log "sidecar container healthy (sshd :2222, omniroute :20128)"
    else
      log "WARN: sidecar container up but services down — restarting it (site unaffected)"
      minirunc kill tectonic 9 2>/dev/null
      sleep 2
      minirunc delete tectonic 2>/dev/null
      sleep 1
      start_sidecar_container 1 || log "WARN: sidecar restart failed — will retry next run"
    fi
    return 0
  fi

  # Container not running: start it, time-boxed. Two attempts max, with one
  # dockerd restart between them if the first hangs (wedge symptom).
  if start_sidecar_container 1; then
    sleep 10
    if container_running; then
      log "sidecar container started"
      return 0
    fi
    log "WARN: drun returned but container not running — will retry next run"
    return 0
  fi
  rc=$?
  if [ "$rc" -eq 124 ]; then
    log "WARN: drun timed out after 180s (dockerd may be wedged)"
    if restart_dockerd_once; then
      start_sidecar_container 2 && sleep 10
      container_running && { log "sidecar container started after dockerd restart"; return 0; }
    fi
  else
    log "WARN: drun failed (exit $rc) — will retry next run"
  fi
  return 0  # never fatal: the site serves from the host node regardless
}

ensure_sidecar
log "supervisor run complete"
exit 0
