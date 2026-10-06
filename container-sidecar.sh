#!/bin/bash
# container-sidecar.sh — drun --entrypoint override for the "tectonic" container.
#
# KIYAMOT-PROOF DESIGN (2026-10-01): the container NEVER runs the node app.
# :3120 is served exclusively by the host node (see monitor.sh), so the
# container can flap, rebuild, or die without ever taking the site down.
# The container is a sidecar only:
#   - sshd on :2222 (root, key + stored-hash password)
#   - OmniRoute AI relay on :20128
# This script lives in /app (bind-mounted from ~/workspace/tectonic-inbox),
# so it works with the already-cached image without a rebuild.
set -e
export HOME=/root

# /run/sshd must be root:root 0755 (runtime umask breaks it otherwise)
chown root:root /run/sshd 2>/dev/null || mkdir -p /run/sshd
chmod 0755 /run/sshd
if [ -r /app/.ssh-pwhash ]; then
  HASH=$(cat /app/.ssh-pwhash)
  if [ -n "$HASH" ] && [ "$HASH" != "*" ]; then
    usermod -p "$HASH" root && echo "[sidecar] root SSH password applied from stored hash"
  fi
fi
/usr/sbin/sshd
echo "[sidecar] sshd started on :2222"

# OmniRoute AI relay: bind-mounted from the host at /opt/omniroute.
# State (providers, keys, dashboard password) is bind-mounted from the
# host's /home/hatch/.omniroute into /root/.omniroute. Shared host network,
# so :20128 here IS the host's :20128 (tunnel ingress for omni.kalandar.me).
if [ -x /opt/omniroute/bin/omniroute ]; then
  (
    while true; do
      /opt/omniroute/bin/omniroute serve --port 20128 --no-open >>/root/.omniroute/logs/container-stdout.log 2>&1
      echo "[sidecar] omniroute exited ($?), restarting in 5s" >&2
      sleep 5
    done
  ) &
  echo "[sidecar] omniroute relay starting on :20128"
else
  echo "[sidecar] WARN: /opt/omniroute not mounted — relay disabled" >&2
fi

# NOTE: deliberately NO `node server.js` here. The host node owns :3120.
# Keep the container (PID 1) alive without binding any app port.
exec tail -f /dev/null
