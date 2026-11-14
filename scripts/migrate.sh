#!/usr/bin/env bash
# ==============================================================================
# Tectobox Database Migration Runner (M18)
#
# Deploy Sequence Location:
# This script must run at Step 3 of the production deployment sequence:
#   1. Update source code:
#      git fetch origin && git merge --ff-only origin/main
#   2. Build container images:
#      docker compose -f infra/docker-compose.prod.yml build
#   3. RUN MIGRATIONS HERE:
#      bash scripts/migrate.sh
#      -> Runs against live Postgres BEFORE containers are recreated with new code.
#      -> Ensures all schema additions/indexes are present before API/workers restart.
#      -> All migrations are backward-compatible and idempotent.
#   4. Recreate containers:
#      docker compose -f infra/docker-compose.prod.yml -p tectobox --project-directory /opt/tectobox up -d --remove-orphans
#   5. Verify container health:
#      docker compose -f infra/docker-compose.prod.yml -p tectobox --project-directory /opt/tectobox ps
#
# Usage:
#   bash scripts/migrate.sh            # Apply pending migrations
#   bash scripts/migrate.sh --dry-run  # Inspect pending migrations without applying
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MIGRATIONS_DIR="${REPO_ROOT}/infra/postgres/migrations"

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=true
      ;;
    -h|--help)
      echo "Usage: $0 [--dry-run]"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "[-] ERROR: Migrations directory not found: $MIGRATIONS_DIR" >&2
  exit 1
fi

# Detect database execution method
run_sql_query() {
  local sql="$1"
  if [ -n "${DATABASE_URL:-}" ] && command -v psql >/dev/null 2>&1; then
    psql -v ON_ERROR_STOP=1 -At -c "$sql" "$DATABASE_URL" 2>/dev/null
  elif command -v psql >/dev/null 2>&1 && [ -n "${PGHOST:-${POSTGRES_HOST:-}}" ]; then
    psql -v ON_ERROR_STOP=1 -At -U "${POSTGRES_USER:-tectobox}" -d "${POSTGRES_DB:-tectobox}" -c "$sql" 2>/dev/null
  elif command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q "^tectobox-prod-postgres$"; then
    docker exec -i tectobox-prod-postgres psql -v ON_ERROR_STOP=1 -At -U "${POSTGRES_USER:-tectobox}" -d "${POSTGRES_DB:-tectobox}" -c "$sql" 2>/dev/null
  elif command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q "^tectobox-postgres$"; then
    docker exec -i tectobox-postgres psql -v ON_ERROR_STOP=1 -At -U "${POSTGRES_USER:-tectobox}" -d "${POSTGRES_DB:-tectobox}" -c "$sql" 2>/dev/null
  else
    return 1
  fi
}

run_sql_file() {
  local file="$1"
  local ver="$2"
  if [ -n "${DATABASE_URL:-}" ] && command -v psql >/dev/null 2>&1; then
    psql -v ON_ERROR_STOP=1 -1 -f "$file" "$DATABASE_URL"
    psql -v ON_ERROR_STOP=1 -c "INSERT INTO schema_migrations (version) VALUES ('$ver');" "$DATABASE_URL"
  elif command -v psql >/dev/null 2>&1 && [ -n "${PGHOST:-${POSTGRES_HOST:-}}" ]; then
    psql -v ON_ERROR_STOP=1 -1 -U "${POSTGRES_USER:-tectobox}" -d "${POSTGRES_DB:-tectobox}" -f "$file"
    psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-tectobox}" -d "${POSTGRES_DB:-tectobox}" -c "INSERT INTO schema_migrations (version) VALUES ('$ver');"
  elif command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q "^tectobox-prod-postgres$"; then
    docker exec -i tectobox-prod-postgres psql -v ON_ERROR_STOP=1 -1 -U "${POSTGRES_USER:-tectobox}" -d "${POSTGRES_DB:-tectobox}" < "$file"
    docker exec -i tectobox-prod-postgres psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-tectobox}" -d "${POSTGRES_DB:-tectobox}" -c "INSERT INTO schema_migrations (version) VALUES ('$ver');"
  elif command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q "^tectobox-postgres$"; then
    docker exec -i tectobox-postgres psql -v ON_ERROR_STOP=1 -1 -U "${POSTGRES_USER:-tectobox}" -d "${POSTGRES_DB:-tectobox}" < "$file"
    docker exec -i tectobox-postgres psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-tectobox}" -d "${POSTGRES_DB:-tectobox}" -c "INSERT INTO schema_migrations (version) VALUES ('$ver');"
  else
    echo "[-] ERROR: No reachable PostgreSQL database instance found to apply migration $ver." >&2
    return 1
  fi
}

# Collect applied migrations
APPLIED_LIST=()
if [ -n "${APPLIED_MIGRATIONS:-${FAKE_APPLIED:-}}" ]; then
  # Support testing or explicit overrides
  IFS=', ' read -r -a APPLIED_LIST <<< "${APPLIED_MIGRATIONS:-${FAKE_APPLIED:-}}"
elif run_sql_query "SELECT 1;" >/dev/null 2>&1; then
  # Initialize schema_migrations tracking table if needed
  run_sql_query "CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());" >/dev/null 2>&1 || true
  while IFS= read -r line; do
    [ -n "$line" ] && APPLIED_LIST+=("$line")
  done < <(run_sql_query "SELECT version FROM schema_migrations ORDER BY version ASC;" 2>/dev/null || true)
fi

is_applied() {
  local target="$1"
  for app in "${APPLIED_LIST[@]}"; do
    if [ "$app" = "$target" ] || [ "${target#"$app"}" != "$target" ] || [ "${app#"$target"}" != "$app" ]; then
      return 0
    fi
  done
  return 1
}

# Discover migration files in sorted order
MIGRATION_FILES=()
while IFS= read -r f; do
  [ -f "$f" ] && MIGRATION_FILES+=("$f")
done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name "*.sql" | sort)

if [ ${#MIGRATION_FILES[@]} -eq 0 ]; then
  echo "[migrate] No SQL migrations found in $MIGRATIONS_DIR."
  exit 0
fi

if [ "$DRY_RUN" = true ]; then
  echo "[dry-run] Migration inspection plan (ordered):"
  for file in "${MIGRATION_FILES[@]}"; do
    ver="$(basename "$file")"
    if is_applied "$ver"; then
      echo "[dry-run] Skipping already-applied: $ver"
    else
      echo "[dry-run] Would apply: $ver"
    fi
  done
  echo "[dry-run] Plan complete."
  exit 0
fi

# Live execution mode: verify DB connection first
if ! run_sql_query "SELECT 1;" >/dev/null 2>&1; then
  echo "[-] ERROR: PostgreSQL connection failed. Ensure database container is running and accessible." >&2
  exit 1
fi

run_sql_query "CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());" >/dev/null

echo "[migrate] Starting database migrations..."
for file in "${MIGRATION_FILES[@]}"; do
  ver="$(basename "$file")"
  if is_applied "$ver"; then
    echo "[migrate] Skipping already-applied: $ver"
  else
    echo "[migrate] Applying migration: $ver..."
    run_sql_file "$file" "$ver"
    echo "[migrate] Successfully applied: $ver"
    APPLIED_LIST+=("$ver")
  fi
done

echo "[migrate] Database migrations complete and up to date."
exit 0
