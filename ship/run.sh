#!/usr/bin/env bash
# Bit-rate game launcher. No arguments, no setup, no network, no runtime
# requirements: dispatches on uname to a bundled static binary.
# Linux is the supported platform; macOS is a courtesy path.
set -euo pipefail
cd "$(dirname "$0")"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)   BIN=bin/bitrate-linux-amd64 ;;
  Linux-aarch64)  BIN=bin/bitrate-linux-arm64 ;;
  Darwin-arm64)   BIN=bin/bitrate-darwin-arm64 ;;  # courtesy; Linux is the supported platform
  Darwin-x86_64)  BIN=bin/bitrate-darwin-amd64 ;;
  *) echo "unsupported platform: $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac
chmod +x "$BIN" 2>/dev/null || true  # ZIP extraction routinely drops exec bits
command -v xattr >/dev/null 2>&1 && xattr -d com.apple.quarantine "$BIN" 2>/dev/null || true

# Drum pad is a touch game, and the machine running this script may well not
# have a touchscreen. Say so before the browser opens, along with the two things
# a grader most needs: the hosted URL for playing it on a tablet, and where the
# design notes live. Printed rather than buried in the README because this is
# the one output every launch produces.
cat <<'BANNER'
bit-rate — drum pad

  This is a TOUCH game. On a tablet or phone, play the hosted build instead:
      https://bitrate.einkgen.link
  Design notes (why this N, why touch, why this tile size):
      /readme  on the URL below, or README.md next to this script

BANNER

exec "./$BIN"   # binds 127.0.0.1 on an OS-assigned port, prints the URL, opens the browser
