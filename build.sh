#!/usr/bin/env bash
# Build script (spec §4.2, §8): go build per target plus ZIP assembly.
# No bundler, no transpiler, no Node toolchain — this is the entire build
# system.
#
#   ./build.sh          build dist/bitrate.zip (ship profile) + local lab binary
#   ./build.sh lab      local lab binary only (bin/bitrate)
set -euo pipefail
cd "$(dirname "$0")"

if [[ "${1:-}" != "lab" ]]; then
  echo "==> ship binaries (static, CGO off, -tags ship)"
  rm -rf dist/stage
  mkdir -p dist/stage/bin
  for target in linux/amd64 linux/arm64 darwin/arm64 darwin/amd64; do
    os="${target%/*}" arch="${target#*/}"
    out="dist/stage/bin/bitrate-${os}-${arch}"
    echo "    ${out}"
    CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
      go build -tags ship -trimpath -ldflags="-s -w" -o "$out" ./server
  done
  cp ship/run.sh ship/README.md dist/stage/
  chmod +x dist/stage/run.sh dist/stage/bin/*
  rm -f dist/bitrate.zip
  (cd dist/stage && zip -rq ../bitrate.zip .)
  echo "==> dist/bitrate.zip ($(du -h dist/bitrate.zip | cut -f1))"
fi

echo "==> lab binary (bin/bitrate)"
mkdir -p bin
go build -o bin/bitrate ./server
echo "done"
