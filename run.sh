#!/usr/bin/env bash
# Dev launcher — builds from source and serves assets from disk.
# The ship run.sh (spec §8: dispatch on uname to prebuilt static binaries,
# zero runtime requirements) is produced by the packaging step (§9 step 4)
# and lands inside dist/bitrate.zip, not here.
set -euo pipefail
cd "$(dirname "$0")"
exec go run ./server -dev "$@"
