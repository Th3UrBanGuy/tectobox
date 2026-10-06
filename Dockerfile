# Tectonic unified inbox — Hugging Face Spaces (Docker) image.
# HF runs the container and routes HTTP to $PORT (7860). Persistent disk
# is mounted at /data (DB + WhatsApp/Telegram session profiles live there).
FROM node:24-bookworm-slim

# Headless-Chrome runtime deps + real zstd (used by @open-wa/session-sync).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    zstd \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

# HF Spaces conventions: HTTP on 7860, persistent data under /data.
# Secrets (META_*, TELEGRAM_*, AI_*, ADMIN_PASSWORD) come from Space Secrets,
# never baked into the image.
ENV PORT=7860 \
    NODE_ENV=production \
    DB_PATH=/data/tectonic-inbox.db \
    SESSION_DIR=/data/sessions \
    CHROME_PATH=/usr/bin/chromium

EXPOSE 7860

CMD ["node", "server.js"]
