#!/bin/sh
set -e

echo "[infra] Stopping existing containers..."
docker rm -f tectobox-postgres tectobox-redis tectobox-rabbitmq 2>/dev/null || true

echo "[infra] Starting PostgreSQL..."
docker run -d --name tectobox-postgres \
  -p 5432:5432 \
  -e POSTGRES_USER=tectobox \
  -e POSTGRES_PASSWORD=tectobox_dev \
  -e POSTGRES_DB=tectobox \
  -v /mnt/e/tectobox-main/infra/postgres/init.sql:/docker-entrypoint-initdb.d/01-init.sql:ro \
  -v /mnt/e/tectobox-main/infra/postgres/schema.sql:/docker-entrypoint-initdb.d/02-schema.sql:ro \
  postgres:16-alpine

echo "[infra] Starting Redis..."
docker run -d --name tectobox-redis \
  -p 6379:6379 \
  redis:7-alpine redis-server --appendonly yes

echo "[infra] Starting RabbitMQ..."
docker run -d --name tectobox-rabbitmq \
  -p 5672:5672 \
  -p 15672:15672 \
  -e RABBITMQ_DEFAULT_USER=tectobox \
  -e RABBITMQ_DEFAULT_PASS=tectobox_dev \
  -e RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS='-rabbitmq_management load_definitions "/etc/rabbitmq/definitions.json"' \
  -v /mnt/e/tectobox-main/infra/rabbitmq/definitions.json:/etc/rabbitmq/definitions.json:ro \
  rabbitmq:3-management-alpine

echo "[infra] All dev infrastructure containers started!"
