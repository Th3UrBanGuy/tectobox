#!/usr/bin/env bash
# ==============================================================================
# Tectobox VPS Automated Host Provisioner & Hardening Script
# Compatible with Ubuntu 20.04/22.04/24.04, Debian 11/12, Rocky Linux 9, AlmaLinux
# ==============================================================================

set -euo pipefail

echo "=========================================================="
echo " Starting Tectobox VPS Environment Setup & Hardening"
echo "=========================================================="

# 1. Verify root privileges
if [ "$(id -u)" -ne 0 ]; then
  echo "[-] ERROR: This script must be run as root (or with sudo)." >&2
  exit 1
fi

# 2. Detect Package Manager and install essentials
if command -v apt-get >/dev/null 2>&1; then
  echo "[+] Updating apt repositories..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    ufw \
    openssl \
    tar \
    gzip \
    jq
elif command -v dnf >/dev/null 2>&1; then
  echo "[+] Updating dnf repositories..."
  dnf install -y curl openssl tar gzip jq firewalld
fi

# 3. Install Docker & Docker Compose Plugin if missing
if ! command -v docker >/dev/null 2>&1; then
  echo "[+] Installing Docker Engine via official automated script..."
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
  systemctl enable --now docker
else
  echo "[+] Docker is already installed: $(docker --version)"
fi

# Verify Docker Compose
if ! docker compose version >/dev/null 2>&1; then
  echo "[+] Installing Docker Compose CLI plugin..."
  mkdir -p ~/.docker/cli-plugins/
  COMPOSE_VERSION=$(curl -s https://api.github.com/repos/docker/compose/releases/latest | jq -r .tag_name)
  curl -SL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-$(uname -m)" -o ~/.docker/cli-plugins/docker-compose
  chmod +x ~/.docker/cli-plugins/docker-compose
fi
echo "[+] Docker Compose version: $(docker compose version)"

# 4. Configure Docker Daemon Security & Log Rotation (prevent disk exhaustion)
echo "[+] Configuring Docker daemon log rotation guard..."
mkdir -p /etc/docker
cat <<'EOF' > /etc/docker/daemon.json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "20m",
    "max-file": "5"
  },
  "live-restore": true
}
EOF
systemctl restart docker || true

# 5. Network Security & Firewall Hardening (UFW)
if command -v ufw >/dev/null 2>&1; then
  echo "[+] Configuring UFW Firewall..."
  # Allow SSH, HTTP, HTTPS only
  ufw --force reset
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp comment "SSH access"
  ufw allow 80/tcp comment "HTTP gateway"
  ufw allow 443/tcp comment "HTTPS gateway"
  echo "y" | ufw enable || true
  echo "[+] UFW active. Internal database and messaging ports are completely blocked from public internet."
fi

# 6. Target Directory Setup
INSTALL_DIR="/opt/tectobox"
echo "[+] Creating installation directory at ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}" "${INSTALL_DIR}/infra" "${INSTALL_DIR}/data"

echo "=========================================================="
echo " VPS Host Provisioning & Hardening Complete!"
echo " Ready for automated Tectobox Docker deployment."
echo "=========================================================="
