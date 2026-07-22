//go:build !ship

package main

// Lab profile (default build): the full harness. Leaderboard, gallery,
// telemetry, export/merge (spec §9 step 6) register their routes here —
// none of it exists in a ship binary, by construction rather than by
// runtime flag (spec §8: stripping happens in the build).

import "net/http"

const buildProfile = "lab"

func (s *server) registerLabRoutes(mux *http.ServeMux) {
	// Step 6 lands leaderboard/gallery/export endpoints here.
	_ = mux
}
