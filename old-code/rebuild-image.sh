#!/bin/bash
# rebuild-image.sh — rebuild the tectonic-ssh:latest container image from scratch.
# Needed because VM reboots/replacements wipe /usr/local/bin, /var/lib/docker and
# /var/lib/drun. Everything this script needs lives in the persistent home dir:
#   ~/workspace/minirunc.py, ~/workspace/drun.py, ~/workspace/docker-29.8.1.tgz
# Fast path: if ~/workspace/tectonic-inbox/tectonic-ssh.tar exists, just docker load it.
# Slow path: full chroot rebuild (node:24-bookworm-slim + openssh-server).
# The container root SSH password is applied from the salted hash file
#   ~/workspace/tectonic-inbox/.ssh-pwhash (0600) when present; otherwise root
# login stays locked and only the app runs.
set -euo pipefail

HERE="$HOME/workspace/tectonic-inbox"
TARBALL="$HERE/tectonic-ssh.tar"
HASHFILE="$HERE/.ssh-pwhash"
LOG="$HERE/rebuild-image.log"
REBUILD_LOCK="$HERE/.rebuild-in-progress"
trap 'rm -f "$REBUILD_LOCK"' EXIT
touch "$REBUILD_LOCK"

log() { echo "[$(date -u '+%F %T')] $*" | tee -a "$LOG"; }

# docker pull needs the egress proxy (the chroot apt step unsets it internally).
if [ -z "${http_proxy:-}" ] && [ -f /etc/profile.d/hatch-egress.sh ]; then
  set -a; . /etc/profile.d/hatch-egress.sh; set +a
fi

# ---- 1. Restore /usr/local/bin tools (wiped on every VM replacement) ----
# drun/minirunc state dirs live under /var/lib/drun and /run (both wiped on
# VM replacement); drun recreates them as needed, but ensure the base exists.
mkdir -p /var/lib/drun/tmp
log "restoring minirunc/drun"
cp "$HOME/workspace/minirunc.py" /usr/local/bin/minirunc
cp "$HOME/workspace/drun.py" /usr/local/bin/drun
chmod +x /usr/local/bin/minirunc /usr/local/bin/drun

# ---- 2. Restore docker static binaries (cached tarball survives reboots) ----
if ! command -v dockerd >/dev/null 2>&1; then
  log "extracting docker binaries"
  rm -rf /tmp/dockerx && mkdir -p /tmp/dockerx
  tar xzf "$HOME/workspace/docker-29.8.1.tgz" -C /tmp/dockerx
  cp /tmp/dockerx/docker/docker /tmp/dockerx/docker/dockerd \
     /tmp/dockerx/docker/runc /tmp/dockerx/docker/containerd-shim-runc-v2 \
     /usr/local/bin/
  chmod +x /usr/local/bin/docker /usr/local/bin/dockerd \
            /usr/local/bin/runc /usr/local/bin/containerd-shim-runc-v2
  rm -rf /tmp/dockerx
fi

# ---- 3. Start dockerd (vfs storage, no iptables/bridge — matches prior setup) ----
if ! pgrep -f "docker[d] --storage-driver=vfs" >/dev/null 2>&1; then
  log "starting dockerd"
  mkdir -p /var/lib/docker /var/run
  nohup dockerd --storage-driver=vfs --iptables=false --bridge=none \
    --userland-proxy=false >/var/log/dockerd.log 2>&1 &
  for i in $(seq 1 30); do
    docker info >/dev/null 2>&1 && break
    sleep 2
  done
  docker info >/dev/null 2>&1 || { log "ERROR: dockerd failed to start"; exit 1; }
fi

# ---- 4. Fast path: load cached image tarball ----
if [ -f "$TARBALL" ]; then
  log "loading cached image tarball ($(du -h "$TARBALL" | cut -f1))"
  docker load -i "$TARBALL" 2>&1 | tail -1 | tee -a "$LOG"
  if docker image inspect tectonic-ssh:latest >/dev/null 2>&1; then
    log "image restored from cache — done"
    exit 0
  fi
  log "WARN: cached tarball failed, falling through to full rebuild"
fi

# ---- 5. Slow path: full chroot rebuild ----
log "full rebuild: pulling node:24-bookworm-slim"
docker pull node:24-bookworm-slim 2>&1 | tail -2 | tee -a "$LOG"

ROOTFS="$HERE/build-rootfs"
log "exporting base rootfs to $ROOTFS (disk-backed, NOT /tmp)"
rm -rf "$ROOTFS"
mkdir -p "$ROOTFS"
CID=$(docker create node:24-bookworm-slim)
# --no-same-owner: this sandbox denies chown(2) to arbitrary uids even as
# root; extracting as root already yields root-owned files, which is what
# sshd wants anyway.
docker export "$CID" | tar -x --no-same-owner -C "$ROOTFS"
docker rm "$CID" >/dev/null

# Seed DNS + minimal mounts for chroot apt
cp /etc/resolv.conf "$ROOTFS/etc/resolv.conf"

log "installing openssh-server inside chroot (proxy env unset — it breaks apt)"
chroot "$ROOTFS" /bin/bash -c '
set -e
export DEBIAN_FRONTEND=noninteractive
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY
apt-get update -qq
apt-get install -y -qq openssh-server ca-certificates > /dev/null
rm -rf /var/lib/apt/lists/*
mkdir -p /run/sshd /app
'

# sshd hardening (matches previous image)
cat > "$ROOTFS/etc/ssh/sshd_config.d/tectonic.conf" <<'EOF'
Port 2222
MaxAuthTries 3
LoginGraceTime 60
MaxSessions 5
X11Forwarding no
PermitEmptyPasswords no
AllowAgentForwarding no
UseDNS no
GSSAPIAuthentication no
PermitRootLogin yes
PasswordAuthentication yes
EOF

# Root password from stored salted hash (never the plaintext)
if [ -f "$HASHFILE" ]; then
  HASH=$(cat "$HASHFILE")
  chroot "$ROOTFS" /usr/sbin/usermod -p "$HASH" root
  log "root password hash applied from stored hash file"
else
  chroot "$ROOTFS" /usr/sbin/usermod -p '*' root
  log "no stored password hash — root login locked (app still runs)"
fi

# (No omniroute copy here: the relay is bind-mounted from the host's
# /home/hatch/workspace/omniroute into /opt/omniroute at container start —
# keeps the image small and decouples relay updates from image rebuilds.)

# Entrypoint: runtime umask is 0007, so fix /run/sshd ownership/perms first.
# The container root SSH password is applied here (not just at build time)
# from the bind-mounted hash file /app/.ssh-pwhash (0600, never served —
# dotfiles are blocked by the app). This way the password can be set or
# rotated without rebuilding the image, and every auto-rebuild after a VM
# reboot picks it up with zero user interaction.
# Also starts the OmniRoute AI relay: bind-mounted from the host at
# /opt/omniroute (host install survives VM replacements; image stays small).
# Relay state is bind-mounted from the host's /home/hatch/.omniroute into
# /root/.omniroute. The container shares the host network namespace, so
# :20128 here IS the host's :20128 (tunnel ingress for omni.kalandar.me
# unchanged).
cat > "$ROOTFS/app-entrypoint.sh" <<'EOF'
#!/bin/bash
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
cd /app
exec node server.js
EOF
chmod +x "$ROOTFS/app-entrypoint.sh"

log "importing image"
tar -C "$ROOTFS" -c . | docker import \
  -c 'ENV NODE_ENV=production' \
  -c 'WORKDIR /app' \
  -c 'ENTRYPOINT ["/app-entrypoint.sh"]' \
  -c 'EXPOSE 3120 2222 20128' \
  - tectonic-ssh:latest 2>&1 | tee -a "$LOG"

# ---- 6. Cache the image for next time (fast path on future reboots) ----
log "saving image tarball for future fast restores"
docker save tectonic-ssh:latest -o "$TARBALL"
chmod 600 "$TARBALL"
log "rebuild complete: $(docker image inspect tectonic-ssh:latest --format '{{.Id}}' | cut -c1-19), tarball $(du -h "$TARBALL" | cut -f1)"
