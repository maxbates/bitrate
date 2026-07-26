# AWS deploy — public pilot (spec §6)

Infrastructure-as-code for the public pilot instance. **Tier B** (deploy tooling,
never ships — spec §4.1). Nothing here is needed to build or run the deliverable.

## What it stands up

A single CloudFormation stack (`bitrate`, `us-east-1`):

- **EC2** (`t3.micro`, Amazon Linux 2023) running the lab Go binary under
  `systemd`, behind **Caddy** for automatic Let's Encrypt HTTPS.
- **Elastic IP** + a **Route 53 A record** `bitrate.einkgen.link` (in the
  existing `einkgen.link` zone).
- **S3 artifact bucket** (`bitrate-deploy-<account>`) holding the current binary;
  the instance pulls it on boot and on each deploy.
- **A separate, retained EBS data volume** mounted at `/var/lib/bitrate` holding
  the JSONL ledger — see *Data durability* below.
- **IAM instance role** (S3 read + SSM). **No SSH** — shell and deploys go
  through SSM Session Manager / Run Command; only ports 80 and 443 are open.

```
                internet ──443──▶ Caddy ──▶ 127.0.0.1:4700 (bitrate, BITRATE_PUBLIC=1)
                                   │                         │
                          Let's Encrypt              /var/lib/bitrate  (JSONL ledger)
```

## Deploy

```
./deploy/aws/deploy.sh
```

Idempotent. First run creates everything and uploads the binary; later runs
rebuild → re-upload → restart the service (SSM). The stack only changes when
`cloudformation.yaml` does. Allow ~2–3 min on first run for boot, DNS, and cert
issuance, then open <https://bitrate.einkgen.link>.

## Hardening on the public instance (spec §6)

The binary runs with `BITRATE_PUBLIC=1`, which the app treats as "exposed":

- **Per-IP rate limit** on `/api/*` (120 req/min) — blunts submit-hammering.
- **Body-size cap** (4 MiB) on POST `/api/*` — always on, stops oversized submits.
- **`/api/export*` is token-gated** via `BITRATE_EXPORT_TOKEN` (the quasi-biometric
  keystroke dumps). The token is generated once into `~/.bitrate/export-token`
  and passed to the stack; it is **never** committed.
- **Consent banner** shown on every non-loopback page load (frontend, gated to
  non-localhost so it never appears in local/grader play).

## Data durability — does a redeploy keep the leaderboard?

**Yes.** The leaderboard is a query over the `runs`/`results` JSONL (spec §4.4),
so the question is only whether those files survive. Two independent guarantees:

1. **Routine redeploy** (`deploy.sh`: rebuild → S3 → `systemctl restart bitrate`)
   only restarts the process. The ledger is untouched on disk and is re-loaded at
   boot.
2. **Instance replacement** (AMI bump, `UserData` edit, instance-type change —
   anything CloudFormation implements by building a new EC2 instance) also keeps
   it, because the ledger is **not** on the root volume. It lives on `DataVolume`,
   a separate EBS volume with `DeletionPolicy: Retain` / `UpdateReplacePolicy: Retain`
   that is detached from the old instance and re-attached to the new one. The
   boot script formats it **only** when `blkid` finds no filesystem, so an
   existing ledger is never wiped.

Two guardrails make that hard to get wrong by accident:

- `RequiresMountsFor=/var/lib/bitrate` on the unit — if the volume ever fails to
  mount, the service **refuses to start** rather than quietly writing a fresh,
  empty ledger to the root volume (which would look exactly like data loss).
- **`AmiId` is a pinned literal**, not the `ami-amazon-linux-latest` SSM lookup.
  That lookup resolves at deploy time, so once Amazon republished the AMI, an
  unrelated redeploy would have silently replaced the instance. Replacement is
  now safe for data, but it still costs ~2 min of downtime and a fresh cert, so
  it should be deliberate: bump `AmiId` by hand when you want a newer OS.

What is still **not** protected: `delete-stack` destroys the instance, and
terminating/deleting the volume by hand destroys the ledger (the volume is
retained on stack delete, so it survives as an orphan you can re-attach or
delete deliberately). EBS is a single AZ — for real backup, use the pull-to-local
cadence below, which is the actual system of record per spec §4.4.

> On a replacement, the new instance may boot before CloudFormation has detached
> the volume from the old one; the boot script waits up to 5 min for the device
> to appear, which covers it.

## Getting the data back (pull-to-local)

The instance's disk is **not** the system of record — the export→merge cadence is
(spec §4.4). Pull with the token:

```
TOKEN=$(cat ~/.bitrate/export-token)
curl -fsS "https://bitrate.einkgen.link/api/export?include=keystrokes&token=$TOKEN" \
  | ./bin/bitrate merge -    # merge CLI is spec §4.4 (build if not yet present)
```

(A scripted `lab/pull.sh` wrapper is the spec §8 follow-up; the curl above is the
manual form.)

## Operating

```
# shell on the box (no SSH key needed)
aws ssm start-session --target "$(aws cloudformation describe-stacks \
  --stack-name bitrate --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)"

# logs
sudo journalctl -u bitrate -f
sudo journalctl -u caddy   -f
```

## Cost

`t3.micro` + EIP (in-use EIPs are free) + ~10 GB gp3 root + 10 GB gp3 data
volume (~$0.80/mo, and it persists after teardown until deleted) + minimal
S3/Route 53. Free-tier-eligible accounts: roughly **$0–1**. Otherwise **~$9/mo**. To use ARM
(cheaper Graviton), set `InstanceType=t4g.micro` **and** `AmiId=/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64`,
and change `deploy.sh` to build `GOARCH=arm64` and fetch the `arm64` Caddy.

## Teardown

```
aws cloudformation delete-stack --stack-name bitrate --region us-east-1
```

The S3 bucket **and the data volume** are `Retain`: deleting the stack destroys
the instance but leaves the ledger volume behind as an orphan (and the artifact
bucket intact). Re-attach it to a new stack, or delete both by hand once you're
sure:

```
aws ec2 describe-volumes --filters Name=tag:Name,Values=bitrate-data \
  --query 'Volumes[].{id:VolumeId,state:State,size:Size}' --output table
```

Retained volumes still cost ~$0.80/mo, so delete them deliberately rather than
forgetting them. Pull the data first (above) regardless — EBS is single-AZ and
is not a backup.
