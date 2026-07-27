package bitrate

import _ "embed"

// README is the project's one README, at the repo root: GitHub's landing page
// for the public repo *and* the page served at /readme, rendered by
// server/readme.go. One file, two audiences, no copy to drift.
//
// It lives at the root rather than in a packaging directory because the
// submission is the deployed site plus the public repo (spec §8) — so the
// markdown a reader sees on GitHub and the page a player reaches from the
// results card have to be the same bytes.
//
//go:embed README.md
var README []byte
