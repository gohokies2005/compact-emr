#!/usr/bin/env bash
set -euo pipefail

# Applies Prisma migration SQL files directly via psql, bypassing the Prisma
# CLI entirely. We tried 4 commits to get `prisma migrate deploy` running on
# CodeBuild but Prisma 7.x requires Node 20.19+ and AL2023:5 defaults to Node 18.
#
# Iterates ALL migrations in backend/prisma/migrations/ in alphabetical order,
# applying each one that hasn't been recorded as finished in _prisma_migrations.
# Idempotent — re-running is a no-op if everything is already applied.
#
# Required CodeBuild environment variables:
#   DATABASE_URL_SECRET_ARN  - ARN of an RDS-style JSON secret with keys
#                              { username, password, host, port, dbname? }
# Optional:
#   DATABASE_URL             - if set, used verbatim; secret lookup skipped.

if [ -z "${DATABASE_URL:-}" ]; then
  if [ -z "${DATABASE_URL_SECRET_ARN:-}" ]; then
    echo "ERROR: Need DATABASE_URL or DATABASE_URL_SECRET_ARN" >&2
    exit 1
  fi

  SECRET_JSON=$(aws secretsmanager get-secret-value \
    --secret-id "$DATABASE_URL_SECRET_ARN" \
    --query SecretString \
    --output text)

  DB_USER=$(echo "$SECRET_JSON" | jq -r .username)
  DB_PASS=$(echo "$SECRET_JSON" | jq -r .password)
  DB_HOST=$(echo "$SECRET_JSON" | jq -r .host)
  DB_PORT=$(echo "$SECRET_JSON" | jq -r .port)
  DB_NAME=$(echo "$SECRET_JSON" | jq -r '.dbname // "compact_emr"')

  DB_USER_ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$DB_USER")
  DB_PASS_ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$DB_PASS")

  export DATABASE_URL="postgresql://${DB_USER_ENC}:${DB_PASS_ENC}@${DB_HOST}:${DB_PORT}/${DB_NAME}?sslmode=require"
fi

# Bootstrap _prisma_migrations if needed (matches Prisma's actual schema)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
CREATE TABLE IF NOT EXISTS _prisma_migrations (
  id varchar(36) PRIMARY KEY,
  checksum varchar(64) NOT NULL,
  finished_at timestamptz,
  migration_name varchar(255) NOT NULL,
  logs text,
  rolled_back_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  applied_steps_count int NOT NULL DEFAULT 0
);
"

APPLIED_COUNT=0
SKIPPED_COUNT=0

for MIGRATION_DIR in $(ls -d backend/prisma/migrations/*/ | sort); do
  MIGRATION_NAME=$(basename "$MIGRATION_DIR")
  SQL_FILE="${MIGRATION_DIR}migration.sql"

  if [ ! -f "$SQL_FILE" ]; then
    echo "WARN: $MIGRATION_NAME has no migration.sql, skipping."
    continue
  fi

  ALREADY=$(psql "$DATABASE_URL" -tAc "SELECT 1 FROM _prisma_migrations WHERE migration_name = '$MIGRATION_NAME' AND finished_at IS NOT NULL LIMIT 1;")
  if [ "$ALREADY" = "1" ]; then
    echo "Migration $MIGRATION_NAME already applied (idempotent skip)."
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi

  echo "Applying migration $MIGRATION_NAME..."

  MIGRATION_ID=$(uuidgen 2>/dev/null || python3 -c 'import uuid;print(uuid.uuid4())')
  CHECKSUM=$(sha256sum "$SQL_FILE" | cut -d' ' -f1)

  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at)
VALUES ('$MIGRATION_ID', '$CHECKSUM', '$MIGRATION_NAME', now());
"

  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$SQL_FILE"

  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
UPDATE _prisma_migrations
SET finished_at = now(), applied_steps_count = 1
WHERE id = '$MIGRATION_ID';
"

  echo "Migration $MIGRATION_NAME applied successfully."
  APPLIED_COUNT=$((APPLIED_COUNT + 1))
done

echo ""
echo "=== Migration run complete: $APPLIED_COUNT applied, $SKIPPED_COUNT already-applied. ==="
