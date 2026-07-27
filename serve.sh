#!/usr/bin/env bash
# Run the game locally from source. This was `run.sh` until run.sh became the
# launcher the brief actually asks for (it opens the deployed game); the local
# server is still here because it is load-bearing in two ways:
#
#   1. it is the fallback if the deployed site is unreachable during grading —
#      the only mitigation for that risk (spec §8, §1 register item 7)
#   2. the ship gate (lab/ship_gate.py) drives it from a clean tree with the
#      network blocked, on every commit, which is what keeps the "works offline,
#      first try" property true rather than merely claimed
#
# Requires Go and nothing else — no dependencies, no bundler, no package manager
# (CI asserts go.mod stays empty). -dev serves the frontend from environments/ on
# disk so edits show up on reload; drop it to serve the embedded copies exactly
# as the deployed binary does.
#
#   bash serve.sh                # loopback, OS-assigned port
#   bash serve.sh -addr :4700    # bind wide so a phone or iPad on the same WiFi
#                                # can reach it (the server prints the LAN URLs)
set -euo pipefail
cd "$(dirname "$0")"
exec go run ./server -dev "$@"
