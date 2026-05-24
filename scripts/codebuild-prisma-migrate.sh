#!/usr/bin/env bash
set -euo pipefail

# Resolves DATABASE_URL from Secrets Manager (or uses an existing env value)
# then runs `prisma migrate deploy` against it.
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

  DATABASE_URL=$(echo "$SECRET_JSON" | python3 -c '
import json, sys, urllib.parse
s = json.load(sys.stdin)
u = urllib.parse.quote(s["username"], safe="")
p = urllib.parse.quote(s["password"], safe="")
print(f"postgresql://{u}:{p}@{s[\"host\"]}:{s[\"port\"]}/{s.get(\"dbname\", \"compact_emr\")}?schema=public")
')
  export DATABASE_URL
fi

cd backend
npx prisma migrate deploy
