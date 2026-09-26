#!/usr/bin/env bash
# Deploys the lead-capture stack, then replaces the placeholder code.
# Idempotent: safe to re-run for either infra or code changes.
set -euo pipefail

STACK_NAME=kineura-lead-capture
FUNCTION_NAME=kineura-lead-capture
REGION=us-east-1
PROFILE="${AWS_PROFILE:-pjlim21}"

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${HOME}/.kineura/lead-capture.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Create it with:" >&2
  echo "  mkdir -p ~/.kineura" >&2
  echo "  printf 'NOTIFY_EMAIL=you@example.com\\nIP_SALT=%s\\n' \"\$(openssl rand -hex 16)\" > $ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"
: "${NOTIFY_EMAIL:?NOTIFY_EMAIL must be set in $ENV_FILE}"
: "${IP_SALT:?IP_SALT must be set in $ENV_FILE}"

echo "==> Running unit tests"
(cd "$BACKEND_DIR" && node --test src/)

echo "==> Deploying stack $STACK_NAME"
aws cloudformation deploy \
  --template-file "$BACKEND_DIR/template.yaml" \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_IAM \
  --region "$REGION" \
  --profile "$PROFILE" \
  --parameter-overrides \
    "NotifyEmail=$NOTIFY_EMAIL" \
    "IpSalt=$IP_SALT"

echo "==> Packaging function code"
DIST="$BACKEND_DIR/dist.zip"
rm -f "$DIST"

# Stage every runtime module (everything except *.test.mjs) so the zip's
# contents sit at the archive root -- Lambda resolves index.handler there,
# not inside a nested src/ folder. Staging also lets us hand PowerShell's
# Compress-Archive a clean directory when `zip` isn't installed (Git Bash
# on Windows ships no zip binary).
STAGE_DIR="$(mktemp -d)"
cleanup() { rm -rf "$STAGE_DIR"; }
trap cleanup EXIT

for f in "$BACKEND_DIR"/src/*.mjs; do
  base="$(basename "$f")"
  [[ "$base" == *.test.mjs ]] && continue
  cp "$f" "$STAGE_DIR/"
done

if command -v zip >/dev/null 2>&1; then
  (cd "$STAGE_DIR" && zip -q -r "$DIST" .)
elif command -v powershell >/dev/null 2>&1 || command -v powershell.exe >/dev/null 2>&1; then
  PWSH_BIN="$(command -v powershell.exe || command -v powershell)"
  WIN_STAGE_DIR="$(cygpath -w "$STAGE_DIR" 2>/dev/null || echo "$STAGE_DIR")"
  WIN_DIST="$(cygpath -w "$DIST" 2>/dev/null || echo "$DIST")"
  "$PWSH_BIN" -NoProfile -Command "Compress-Archive -Path '${WIN_STAGE_DIR}\*' -DestinationPath '${WIN_DIST}' -Force"
else
  echo "Neither 'zip' nor 'powershell' is available to package the Lambda bundle." >&2
  echo "Install zip (or run this on a machine with PowerShell) and re-run." >&2
  exit 1
fi

echo "==> Updating function code"
aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://$DIST" \
  --region "$REGION" \
  --profile "$PROFILE" \
  --output text --query 'LastModified'

rm -f "$DIST"

echo "==> Stack outputs"
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --profile "$PROFILE" \
  --query 'Stacks[0].Outputs' \
  --output table
