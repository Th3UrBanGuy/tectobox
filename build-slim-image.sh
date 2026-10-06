#!/bin/bash
# build-slim-image.sh — rebuild tectonic-ssh:latest WITHOUT the baked-in
# omniroute copy. The relay is bind-mounted from the host instead
# (/home/hatch/workspace/omniroute -> /opt/omniroute), which keeps the image
# small (~300MB), makes drun starts fast again, and lets omniroute update
# without an image rebuild. Relay state stays bind-mounted at
# /root/.omniroute.
set -euo pipefail

HERE="$HOME/workspace/tectonic-inbox"
ROOTFS="$HERE/build-rootfs-slim"
TARBALL="$HERE/tectonic-ssh.tar"
LOG="$HERE/build-slim-image.log"
exec > >(tee -a "$LOG") 2>&1

log() { echo "[$(date -u '+%F %T')] $*"; }

OLD_IMG=$(docker images -a --format '{{.ID}}' --filter "dangling=true" 2>/dev/null | head -1)
if [ -z "$OLD_IMG" ]; then
  log "ERROR: no dangling (pre-relay) image found"; exit 1
fi
FAT_IMG=$(docker image inspect tectonic-ssh:latest --format '{{.Id}}' 2>/dev/null | cut -d: -f2 | cut -c1-12)
log "using base image $OLD_IMG (current fat image: $FAT_IMG)"

log "exporting base rootfs"
rm -rf "$ROOTFS"; mkdir -p "$ROOTFS"
CID=$(docker create "$OLD_IMG")
docker export "$CID" | tar -x --no-same-owner -C "$ROOTFS"
docker rm "$CID" >/dev/null

log "installing entrypoint (sshd + bind-mounted omniroute relay; NO node — see container-sidecar.sh)"
cat > "$ROOTFS/app-entrypoint.sh" <<'EOF'
#!/bin/bash
# Baked image entrypoint. KIYAMOT-PROOF (2026-10-01): the container is a
# sidecar (sshd + omniroute) and NEVER runs the node app — :3120 is served
# by the host node. The live override is /app/container-sidecar.sh passed
# via `drun --entrypoint`; this baked copy is the fallback for both.
set -e
export HOME=/root
# /run/sshd must be root:root 0755 (runtime umask breaks it otherwise)
chown root:root /run/sshd
chmod 0755 /run/sshd
if [ -r /app/.ssh-pwhash ]; then
  HASH=$(cat /app/.ssh-pwhash)
  if [ -n "$HASH" ] && [ "$HASH" != "*" ]; then
    usermod -p "$HASH" root && echo "[entrypoint] root SSH password applied from stored hash"
  fi
fi
/usr/sbin/sshd
# OmniRoute AI relay: bind-mounted from the host at /opt/omniroute (the host
# install survives VM replacements, so the image stays small and relay
# updates don't need an image rebuild). Relay state (providers, keys,
# dashboard password) is bind-mounted from the host's /home/hatch/.omniroute
# into /root/.omniroute. The container shares the host network namespace, so
# :20128 here IS the host's :20128 (tunnel ingress for omni.kalandar.me
# unchanged).
if [ -x /opt/omniroute/bin/omniroute ]; then
  (
    while true; do
      /opt/omniroute/bin/omniroute serve --port 20128 --no-open >>/root/.omniroute/logs/container-stdout.log 2>&1
      echo "[entrypoint] omniroute exited ($?), restarting in 5s" >&2
      sleep 5
    done
  ) &
  echo "[entrypoint] omniroute relay starting on :20128"
else
  echo "[entrypoint] WARN: /opt/omniroute not mounted — relay disabled" >&2
fi
# NOTE: deliberately NO `node server.js` here — the host node owns :3120.
exec tail -f /dev/null
EOF
chmod +x "$ROOTFS/app-entrypoint.sh"

log "importing slim image as tectonic-ssh:latest"
tar -C "$ROOTFS" -c . | docker import \
  -c 'ENV NODE_ENV=production' \
  -c 'WORKDIR /app' \
  -c 'ENTRYPOINT ["/app-entrypoint.sh"]' \
  -c 'EXPOSE 3120 2222 20128' \
  - tectonic-ssh:latest

log "refreshing cached tarball"
docker save tectonic-ssh:latest -o "$TARBALL.new"
chmod 600 "$TARBALL.new"
mv -f "$TARBALL.new" "$TARBALL"

log "removing fat and base images to reclaim /var/lib/docker space"
docker rmi "$FAT_IMG" 2>/dev/null || log "WARN: could not remove fat image $FAT_IMG"
docker rmi "$OLD_IMG" 2>/dev/null || log "WARN: could not remove base image $OLD_IMG"
log "current images:"
docker images 2>/dev/null | head -3

log "cleaning up"
rm -rf "$ROOTFS"
log "done: tarball $(du -h "$TARBALL" | cut -f1)"
