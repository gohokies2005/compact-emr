#!/usr/bin/env bash
set -euo pipefail

# Applies the Prisma migration SQL directly via psql, bypassing the Prisma CLI
# entirely. We tried 4 commits to get `prisma migrate deploy` running on
# CodeBuild but Prisma 7.x requires Node 20.19+ and we couldn't reliably
# select Node 20+ on either STANDARD_7_0 or AMAZON_LINUX_2023_5 images.
#
# This script applies the migration SQL once, then INSERTs a row into
# _prisma_migrations so future `prisma migrate deploy` runs (whenever we
# untangle Node) will see this migration as already-applied and skip it.
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

  # URL-encode user/pass for safety
  DB_USER_ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$DB_USER")
  DB_PASS_ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$DB_PASS")

  export DATABASE_URL="postgresql://${DB_USER_ENC}:${DB_PASS_ENC}@${DB_HOST}:${DB_PORT}/${DB_NAME}?sslmode=require"
fi

# Find the single Prisma migration in the repo
MIGRATION_DIR=$(ls -d backend/prisma/migrations/*/ | head -1)
MIGRATION_NAME=$(basename "$MIGRATION_DIR")
SQL_FILE="${MIGRATION_DIR}migration.sql"

echo "Migration name: $MIGRATION_NAME"
echo "SQL file:       $SQL_FILE"

if [ ! -f "$SQL_FILE" ]; then
  echo "ERROR: SQL file not found at $SQL_FILE" >&2
  exit 1
fi

# Bootstrap _prisma_migrations table if it doesn't yet exist (same shape Prisma creates)
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

# Skip if already applied
ALREADY=$(psql "$DATABASE_URL" -tAc "SELECT 1 FROM _prisma_migrations WHERE migration_name = '$MIGRATION_NAME' AND finished_at IS NOT NULL LIMIT 1;")

if [ "$ALREADY" = "1" ]; then
  echo "Migration $MIGRATION_NAME already applied (idempotent skip)."
  exit 0
fi

echo "Applying migration $MIGRATION_NAME..."

# Insert a started-row first so partial failures are visible
MIGRATION_ID=$(uuidgen 2>/dev/null || python3 -c 'import uuid;print(uuid.uuid4())')
CHECKSUM=$(sha256sum "$SQL_FILE" | cut -d' ' -f1)

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at)
VALUES ('$MIGRATION_ID', '$CHECKSUM', '$MIGRATION_NAME', now());
"

# Apply the actual migration
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$SQL_FILE"

# Mark finished
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
UPDATE _prisma_migrations
SET finished_at = now(), applied_steps_count = 1
WHERE id = '$MIGRATION_ID';
"

echo "Migration $MIGRATION_NAME applied successfully."
