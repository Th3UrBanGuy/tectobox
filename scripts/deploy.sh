#!/usr/bin/env bash
# ==============================================================================
# Tectobox Production Docker Deployment Script
# Executes atomic, zero-downtime container updates and health verification
# ==============================================================================

set -euo pipefail

DEPLOY_DIR="/opt/tectobox"
cd "${DEPLOY_DIR}"

echo "=========================================================="
echo " Starting Tectobox Production Docker Deployment"
echo " Time: $(date -u)"
echo "=========================================================="

# Resolve IMAGE_TAG: fail loudly or default to git rev-parse HEAD
if [ -z "${IMAGE_TAG:-}" ]; then
  if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    IMAGE_TAG="$(git rev-parse HEAD)"
    echo "[+] IMAGE_TAG was not set in environment; defaulted to current commit SHA: ${IMAGE_TAG}"
  else
    echo "[-] ERROR: IMAGE_TAG environment variable must be set to the git commit SHA." >&2
    exit 1
  fi
fi
export IMAGE_TAG

# 1. Ensure .env exists with cryptographically secure credentials
if [ ! -f "${DEPLOY_DIR}/.env" ]; then
  echo "[+] Generating initial production .env with secure random credentials..."
  PG_PASS=$(openssl rand -hex 20)
  REDIS_PASS=$(openssl rand -hex 20)
  RABBIT_PASS=$(openssl rand -hex 20)
  JWT_SEC=$(openssl rand -hex 32)

  cat <<EOF > "${DEPLOY_DIR}/.env"
# Tectobox Production Environment Configuration
NODE_ENV=production
IMAGE_REPO_OWNER=${IMAGE_REPO_OWNER:-th3urbanguy}
IMAGE_TAG=${IMAGE_TAG}
DOMAIN=${DOMAIN:-}

# PostgreSQL Database
POSTGRES_USER=tectobox
POSTGRES_PASSWORD=${PG_PASS}
POSTGRES_DB=tectobox

# Redis In-Memory Cache
REDIS_PASSWORD=${REDIS_PASS}

# RabbitMQ Event Broker
RABBITMQ_USER=tectobox
RABBITMQ_PASS=${RABBIT_PASS}

# Security & Sessions
JWT_SECRET=${JWT_SEC}

# Webhook Credentials (Optional)
META_APP_SECRET=
META_VERIFY_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
EOF
  chmod 600 "${DEPLOY_DIR}/.env"
  echo "[+] Created ${DEPLOY_DIR}/.env (permissions 600)"
else
  echo "[+] Existing .env file found."
fi

# 2. Pull latest container images from GitHub Container Registry (fail-fast, no || true)
echo "[+] Pulling container images (tag: ${IMAGE_TAG})..."
docker compose -f infra/docker-compose.prod.yml -p tectobox --project-directory "${DEPLOY_DIR}" pull

# 3. Spin up / update containers in detached mode
echo "[+] Orchestrating services via Docker Compose..."
docker compose -f infra/docker-compose.prod.yml -p tectobox --project-directory "${DEPLOY_DIR}" up -d --remove-orphans

# 4. Wait for services to achieve healthy state
echo "[+] Verifying service health..."
MAX_RETRIES=24
COUNT=0
HEALTHY=false

while [ $COUNT -lt $MAX_RETRIES ]; do
  if curl -sf http://127.0.0.1:80/healthz >/dev/null 2>&1 || curl -sf http://127.0.0.1:80/api/healthz >/dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  COUNT=$((COUNT + 1))
  echo "    Waiting for gateway and API to respond (attempt $COUNT/$MAX_RETRIES)..."
  sleep 5
done

if [ "$HEALTHY" = true ]; then
  echo "=========================================================="
  echo " [✓] Tectobox Successfully Deployed and Healthy!"
  echo "=========================================================="
  docker compose -f infra/docker-compose.prod.yml -p tectobox --project-directory "${DEPLOY_DIR}" ps
else
  echo "[-] WARNING: Health check timeout after 120s. Inspecting container logs:"
  docker compose -f infra/docker-compose.prod.yml -p tectobox --project-directory "${DEPLOY_DIR}" logs --tail=40
  exit 1
fi
