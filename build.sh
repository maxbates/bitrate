#!/usr/bin/env bash
# Build script (spec §4.2). No bundler, no transpiler, no Node toolchain —
# this is the entire build system.
#
#   ./build.sh          build the local binary (bin/bitrate)
#   ./build.sh deploy   also cross-compile the linux/amd64 binary the public
#                       instance runs (deploy/aws/deploy.sh does this itself)
#
# There is no ZIP step any more. The submission is the deployed site plus the
# public repo (spec §8, §1 register item 7), so there is no bundle to assemble
# and no packaging directory to stage it in — `ship/` is gone, and README.md
# lives at the repo root where GitHub and /readme both read the same file.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> local binary (bin/bitrate)"
mkdir -p bin
go build -o bin/bitrate ./server

if [[ "${1:-}" == "deploy" ]]; then
  echo "==> linux/amd64 binary (dist/bitrate-linux-amd64)"
  mkdir -p dist
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o dist/bitrate-linux-amd64 ./server
fi

echo "done"
