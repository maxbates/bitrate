//go:build !ship

package main

// Lab profile (default build): the full harness. Leaderboard, run detail,
// export (lab_api.go) register here — none of it exists in a ship binary,
// by construction rather than by runtime flag (spec §8: stripping happens
// in the build).

import "net/http"

const buildProfile = "lab"

func (s *server) registerLabRoutes(mux *http.ServeMux) {
	s.registerLabRoutesImpl(mux)
}
