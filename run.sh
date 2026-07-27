#!/usr/bin/env bash
# Launch the game locally. This is the repo's only run.sh: both the dev launcher
# and the artifact requirement 5 asks for — "include a run.sh script (or
# equivalent) that launches the game with no exotic setup".
#
# The intended way to play is the deployed site (see README.md): drum pad is a
# touch game, and a local server on a laptop cannot hand you a touchscreen. This
# path exists so the repo stands on its own.
#
# Requires Go and nothing else — no dependencies, no bundler, no package manager
# (CI asserts go.mod stays empty). -dev serves the frontend from environments/ on
# disk so edits show up on reload; drop it to serve the embedded copies exactly
# as the deployed binary does.
#
#   bash run.sh                # loopback, OS-assigned port
#   bash run.sh -addr :4700    # bind wide so a phone or iPad on the same WiFi
#                              # can reach it (the server prints the LAN URLs)
set -euo pipefail
cd "$(dirname "$0")"
exec go run ./server -dev "$@"
