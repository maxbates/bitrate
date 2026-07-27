#!/usr/bin/env bash

# Science Corp submission for Maxwell Bates
#
# The game is a deployed web app — drum pad is a touch game, and a local server
# on a laptop cannot hand you a touchscreen — so launching it means opening it.
# This opens two tabs: the README on GitHub, and the game itself, focused and
# ready to play. Open it on a tablet or phone for the real thing.
#
# Nothing needs to be installed: no Go, no Python, no package manager. Both URLs
# are printed before anything is opened, so if this machine has no browser to
# open (headless box, no xdg-open, locked-down desktop) the fallback is a
# copy-paste rather than a dead end.
#
# To run the game locally from source instead — offline, no deployed site
# needed — use ./serve.sh from the repo, which needs Go.
set -euo pipefail

GAME_URL="https://bitrate.einkgen.link"
README_URL="https://github.com/maxbates/bitrate#bitrate-games"

if [[ $# -gt 0 ]]; then
  echo "run.sh takes no arguments — it just opens the game." >&2
  echo "To run a local server from source (and pass it flags): bash serve.sh $*" >&2
  exit 2
fi

cat <<BANNER

  Drum Pad — a game for maximizing the bit rate through a human interface

  ▶  play      $GAME_URL   (please open on a tablet or phone — it is a touch game)
  ▶  readme    $README_URL

BANNER

if [[ -n "${BITRATE_NO_BROWSER:-}" ]]; then
  echo "  (BITRATE_NO_BROWSER set — not opening anything)"
  exit 0
fi

# There is no portable "open a URL" command, so dispatch on the platform and
# fall back through the usual ladder. Every branch is best-effort by design:
# the URLs are already printed, so a failure here costs a copy-paste and
# nothing more. Openers are launched detached — sensible-browser and $BROWSER
# exec the browser itself, and would otherwise hold this script open until the
# browser quits.
open_url() {
  local url=$1 background=${2:-}

  if [[ "$(uname -s)" == "Darwin" ]]; then
    # -g opens the tab without raising the browser over this terminal, which
    # is how the readme lands behind the game rather than in front of it.
    if [[ -n $background ]]; then
      open -g "$url" 2>/dev/null
    else
      open "$url" 2>/dev/null
    fi
    return
  fi

  # Linux (the brief's platform) and WSL. There is no equivalent of -g here, so
  # tab order is the only lever: whatever opens last takes focus.
  local opener
  for opener in xdg-open gio wslview x-www-browser sensible-browser "${BROWSER:-}"; do
    [[ -n $opener ]] || continue
    command -v "$opener" >/dev/null 2>&1 || continue
    if [[ $opener == gio ]]; then
      nohup "$opener" open "$url" >/dev/null 2>&1 &
    else
      nohup "$opener" "$url" >/dev/null 2>&1 &
    fi
    disown 2>/dev/null || true
    return 0
  done
  return 1
}

# Readme first and backgrounded, game second, so the game ends up in front.
# The sleep is not cosmetic: if no browser is running yet, the first call cold
# starts it, and a second call fired immediately can be dropped on the floor.
if open_url "$README_URL" background; then
  sleep 1
  open_url "$GAME_URL" || true
else
  echo "  (couldn't open a browser — use the URLs above)"
fi
