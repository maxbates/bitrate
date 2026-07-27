#!/usr/bin/env bash
# Deploy the bit-rate harness to AWS (spec §6 public pilot).
#
#   ./deploy/aws/deploy.sh
#
# Idempotent. First run: creates the CloudFormation stack (EC2 + Caddy + EIP +
# Route 53 record + S3 artifact bucket), builds the lab binary, uploads it, and
# the instance serves it at https://bitrate.einkgen.link. Later runs: rebuild,
# re-upload, restart the service (via SSM — no SSH). The stack itself only
# changes when cloudformation.yaml does.
set -euo pipefail
cd "$(dirname "$0")/../.." # repo root

STACK=bitrate
REGION=us-east-1
TEMPLATE=deploy/aws/cloudformation.yaml
TOKEN_FILE="${HOME}/.bitrate/export-token"
# Passed explicitly for the same reason AmiId is: `cloudformation deploy` reuses
# the PREVIOUS value of any parameter you don't override, so a template-only
# change to a default is silently ignored on an existing stack.
ALERT_EMAIL="${BITRATE_ALERT_EMAIL:-maxbates@gmail.com}"

# --- export token: generated once, persisted (never in the repo). Redeploys
#     reuse it so pull-to-local (which presents it) keeps working. ---
mkdir -p "$(dirname "$TOKEN_FILE")"
if [[ ! -s "$TOKEN_FILE" ]]; then
  head -c 24 /dev/urandom | base64 | tr -d '/+=' >"$TOKEN_FILE"
  echo "==> generated export token -> $TOKEN_FILE"
fi
TOKEN="$(cat "$TOKEN_FILE")"

# --- pinned AMI, read from the template so it has ONE source of truth.
#     It must be passed explicitly: `cloudformation deploy` reuses the PREVIOUS
#     parameter value for anything not overridden, so a template-only AMI bump
#     would otherwise be silently ignored. ---
AMI_PIN="$(awk '/^  AmiId:/{f=1} f&&/Default:/{print $2; exit}' "$TEMPLATE")"
if [[ ! "$AMI_PIN" =~ ^ami-[0-9a-f]+$ ]]; then
  echo "could not read a pinned AmiId from $TEMPLATE (got '$AMI_PIN')" >&2
  exit 1
fi
echo "==> pinned AMI: $AMI_PIN"

# --- stack (create or update; no-op when unchanged) ---
echo "==> cloudformation deploy ($STACK, $REGION)"
aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK" \
  --template-file "$TEMPLATE" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides ExportToken="$TOKEN" AmiId="$AMI_PIN" AlertEmail="$ALERT_EMAIL" \
  --no-fail-on-empty-changeset

read_out() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
BUCKET="$(read_out ArtifactBucket)"
BACKUP_BUCKET="$(read_out BackupBucket)"
INSTANCE="$(read_out InstanceId)"
URL="$(read_out URL)"

# --- build the lab binary: stdlib-only, static, all env assets embedded ---
echo "==> build linux/amd64 lab binary"
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -trimpath -ldflags="-s -w" -o dist/bitrate-linux-amd64 ./server

echo "==> upload -> s3://$BUCKET/bitrate"
aws s3 cp dist/bitrate-linux-amd64 "s3://$BUCKET/bitrate"

# --- static backup site (spec §8.1): emitted by the binary just built, so it
#     cannot drift from what the server serves, then synced to the bucket
#     CloudFront fronts. --delete so a removed asset actually disappears from
#     the backup instead of lingering as a stale copy. ---
if [[ -n "$BACKUP_BUCKET" && "$BACKUP_BUCKET" != "None" ]]; then
  echo "==> emit static backup site"
  rm -rf dist/static
  go run ./server -emit-static dist/static
  echo "==> sync -> s3://$BACKUP_BUCKET/"
  aws s3 sync dist/static "s3://$BACKUP_BUCKET/" --delete --only-show-errors
else
  echo "    (no backup bucket in stack outputs yet — skipping static sync)"
fi

# --- restart to pick up the new binary. On first boot the instance may not be
#     SSM-registered yet; that's fine — the service auto-pulls within ~10s
#     (Restart=always), so a failed restart here is not fatal. ---
echo "==> restart bitrate on $INSTANCE"
if aws ssm describe-instance-information --region "$REGION" \
  --filters "Key=InstanceIds,Values=$INSTANCE" \
  --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null | grep -q Online; then
  aws ssm send-command --region "$REGION" \
    --instance-ids "$INSTANCE" \
    --document-name AWS-RunShellScript \
    --parameters 'commands=["systemctl restart bitrate","sleep 2","systemctl is-active bitrate"]' \
    --query "Command.CommandId" --output text
else
  echo "    instance not SSM-registered yet (first boot?) — it will auto-pull the new binary within ~10s"
fi

# --- durability assertion: the ledger MUST live on the retained data volume,
#     not the root disk. If this ever fails, redeploys are one instance
#     replacement away from losing the leaderboard - so it is checked, loudly,
#     on every deploy rather than trusted. ---
echo "==> verify ledger is on the retained data volume"
if CHECK_ID=$(aws ssm send-command --region "$REGION" \
  --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["findmnt -no SOURCE,FSTYPE /var/lib/bitrate || echo NOT-A-MOUNT","systemctl is-active bitrate"]' \
  --query "Command.CommandId" --output text 2>/dev/null); then
  sleep 6
  OUT=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CHECK_ID" \
    --instance-id "$INSTANCE" --query 'StandardOutputContent' --output text 2>/dev/null || true)
  if grep -q "NOT-A-MOUNT" <<<"$OUT"; then
    echo "    !! /var/lib/bitrate is NOT a separate mount - data would die with the instance" >&2
    echo "$OUT" >&2
    exit 1
  fi
  echo "    ok: $(head -1 <<<"$OUT")"
else
  echo "    (skipped - instance not SSM-registered yet)"
fi

echo
echo "==> done"
echo "    $URL"
echo "    (first deploy: allow ~2-3 min for boot + DNS + Let's Encrypt cert issuance)"
