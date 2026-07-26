//go:build !ship

package main

// Lab-only endpoints (spec §4.3, §4.4) — compiled out of ship builds:
//
//	GET /api/leaderboard   rankings + full run history + variant registry
//	GET /api/variants      registry
//	GET /api/runs/{id}     run + result (metrics); ?keystrokes=1 for the log
//	GET /api/export        JSON bundle for backup/merge
//	GET /assignment.pdf    the homework brief this harness was built against
//
// The leaderboard is a query, not a table: best bps per (device, variant)
// over scored, completed, verified runs; ties broken by earlier timestamp.
// It derives entirely from run/result, so merging runs merges the
// leaderboard for free (spec §4.4).

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"bitrate"
)

func (s *server) registerLabRoutesImpl(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/leaderboard", s.handleLeaderboard)
	mux.HandleFunc("GET /api/variants", s.handleVariants)
	mux.HandleFunc("GET /api/runs/{id}", s.handleRunDetail)
	mux.HandleFunc("GET /api/export", s.gateExport(s.handleExport))
	mux.HandleFunc("GET /api/export.csv", s.gateExport(s.handleExportCSV))
	mux.HandleFunc("GET /assignment.pdf", handleAssignmentPDF)
}

// handleAssignmentPDF serves the embedded brief. ServeContent (rather than a
// bare Write) gets Content-Type, Range support and conditional requests for
// free — the file is ~120 KB and never changes, so it caches well. modtime is
// zero because an embedded byte slice has none; that just suppresses
// Last-Modified.
func handleAssignmentPDF(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Disposition", `inline; filename="assignment.pdf"`)
	w.Header().Set("Cache-Control", "public, max-age=3600")
	http.ServeContent(w, r, "assignment.pdf", time.Time{}, bytes.NewReader(bitrate.AssignmentPDF))
}

// gateExport protects the full-dataset dumps — which include the quasi-biometric
// keystroke logs (§6) — behind a shared token WHEN one is configured via
// BITRATE_EXPORT_TOKEN (set on the public deploy). With no token set (local lab
// use) export stays open, so lab/pull.sh and the analysis notebooks are
// unaffected; the deploy passes the token, so pull-to-local still works.
func (s *server) gateExport(h http.HandlerFunc) http.HandlerFunc {
	token := os.Getenv("BITRATE_EXPORT_TOKEN")
	return func(w http.ResponseWriter, r *http.Request) {
		if token != "" && r.URL.Query().Get("token") != token && r.Header.Get("X-Export-Token") != token {
			httpErr(w, http.StatusForbidden, "export requires a token")
			return
		}
		h(w, r)
	}
}

// handleExportCSV: one row per completed run, env-agnostic, chronological —
// the whole ledger as a flat table that drops straight into a notebook.
func (s *server) handleExportCSV(w http.ResponseWriter, r *http.Request) {
	type row struct {
		run *Run
		res *Result
		env string
	}
	s.store.mu.RLock()
	rows := make([]row, 0, len(s.store.results))
	for id, res := range s.store.results {
		run := s.store.runs[id]
		env := ""
		if run != nil {
			env = effectiveEnv(s.store.variants[run.VariantID])
		}
		rows = append(rows, row{run, res, env})
	}
	s.store.mu.RUnlock()
	sort.Slice(rows, func(i, j int) bool {
		var ti, tj string
		if rows[i].run != nil {
			ti = rows[i].run.StartedAt
		}
		if rows[j].run != nil {
			tj = rows[j].run.StartedAt
		}
		return ti < tj
	})

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="bitrate-runs.csv"`)
	cw := csv.NewWriter(w)
	cw.Write([]string{
		"run_id", "started_at", "ended_at", "environment", "config_hash", "device_id",
		"scored", "first_contact", "verified", "anomaly", "invalidated",
		"n", "sc", "si", "bits_per_selection", "bps", "t_seconds", "accuracy_pct",
	})
	ff := func(v float64) string { return strconv.FormatFloat(v, 'f', 4, 64) }
	bs := func(b bool) string {
		if b {
			return "true"
		}
		return "false"
	}
	for _, rw := range rows {
		res := rw.res
		var startedAt, endedAt, hash, dev string
		var scored, first, verified, anomaly, invalid bool
		if rw.run != nil {
			startedAt, endedAt = rw.run.StartedAt, rw.run.EndedAt
			hash, dev = rw.run.VariantID, rw.run.DeviceID
			scored, first = rw.run.IsScored, rw.run.IsFirstContact
			verified = verifiedRun(rw.run)
			anomaly, invalid = rw.run.Flags["anomaly"], rw.run.Flags["invalidated"]
		}
		acc := ""
		if res.Sc+res.Si > 0 {
			acc = strconv.FormatFloat(100*float64(res.Sc)/float64(res.Sc+res.Si), 'f', 1, 64)
		}
		cw.Write([]string{
			res.RunID, startedAt, endedAt, rw.env, hash, dev,
			bs(scored), bs(first), bs(verified), bs(anomaly), bs(invalid),
			strconv.Itoa(res.N), strconv.Itoa(res.Sc), strconv.Itoa(res.Si),
			ff(res.BitsPerSelection), ff(res.Bps), ff(res.TSeconds), acc,
		})
	}
	cw.Flush()
}

// historyEntry is one completed run, compact — the raw material for
// rankings, progress strips, and gallery stats alike (same query,
// different cuts — spec §4.4).
type historyEntry struct {
	RunID        string  `json:"run_id"`
	DeviceID     string  `json:"device_id"`
	Pseudonym    string  `json:"pseudonym"`
	VariantID    string  `json:"variant_id"`
	Environment  string  `json:"environment"`
	Bps          float64 `json:"bps"`
	N            int     `json:"n"`
	Sc           int     `json:"sc"`
	Si           int     `json:"si"`
	TSeconds     float64 `json:"t_seconds"`
	Selections   int     `json:"selections"`
	EndedAt      string  `json:"ended_at"`
	IsScored     bool    `json:"is_scored"`
	FirstContact bool    `json:"is_first_contact"`
	Anomaly      bool    `json:"anomaly"`
	Verified     bool    `json:"verified"`
	// Which round of this game this run was for this player: Round counts
	// every completed run of the environment, ScoredRound only the scored ones
	// (0 for a practice bout). Assigned in buildHistory, which is where the
	// runs are already in the order that defines them.
	Round       int `json:"round"`
	ScoredRound int `json:"scored_round"`
}

type lbRow struct {
	historyEntry
	Rank int `json:"rank"`
}

// verifiedRun is the v1 human-verification cut (spec §7: synthetic-player
// entries must be excluded from rankings): a real browser UA, not
// headless. The §6 bot heuristics (IKI variance etc.) extend this later.
func verifiedRun(r *Run) bool {
	if len(r.ClientMeta) == 0 {
		return false // curl / test harness
	}
	var meta struct {
		UA string `json:"ua"`
	}
	if err := json.Unmarshal(r.ClientMeta, &meta); err != nil || meta.UA == "" {
		return false
	}
	return !strings.Contains(meta.UA, "Headless")
}

func pseudonym(deviceID string) string {
	if len(deviceID) < 4 {
		return "runner-????"
	}
	return "runner-" + deviceID[:4]
}

func (s *server) buildHistory() []historyEntry {
	s.store.mu.RLock()
	defer s.store.mu.RUnlock()
	var out []historyEntry
	for id, res := range s.store.results {
		run := s.store.runs[id]
		if run == nil || run.EndedAt == "" || run.Flags["invalidated"] {
			continue
		}
		env := effectiveEnv(s.store.variants[run.VariantID])
		sel := 0
		if res.Metrics != nil {
			sel = res.Metrics.Selections
		}
		out = append(out, historyEntry{
			RunID:        id,
			DeviceID:     run.DeviceID,
			Pseudonym:    pseudonym(run.DeviceID),
			VariantID:    run.VariantID,
			Environment:  env,
			Bps:          res.Bps,
			N:            res.N,
			Sc:           res.Sc,
			Si:           res.Si,
			TSeconds:     res.TSeconds,
			Selections:   sel,
			EndedAt:      run.EndedAt,
			IsScored:     run.IsScored,
			FirstContact: run.IsFirstContact,
			Anomaly:      res.Anomaly,
			Verified:     verifiedRun(run),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].EndedAt < out[j].EndedAt })

	// Which round this was for that player: their nth completed run of this
	// game, counting practice, plus the nth of their scored ones. Derived from
	// the ordering above rather than stamped on the run at start time — a
	// number that lives in the query can't drift from the runs it counts, it's
	// already true of every run in the ledger, and merging two ledgers
	// renumbers correctly for free (spec §4.4: the board is a query, not a
	// table). Invalidated and unfinished runs never reach here, so they don't
	// consume a round.
	type key struct{ device, env string }
	round, scoredRound := map[key]int{}, map[key]int{}
	for i := range out {
		k := key{out[i].DeviceID, out[i].Environment}
		round[k]++
		out[i].Round = round[k]
		if out[i].IsScored {
			scoredRound[k]++
			out[i].ScoredRound = scoredRound[k]
		}
	}
	return out
}

func (s *server) handleLeaderboard(w http.ResponseWriter, r *http.Request) {
	history := s.buildHistory()

	// Best verified scored run per (device, variant); ties -> earlier run.
	best := map[string]historyEntry{}
	for _, h := range history {
		if !h.IsScored || !h.Verified || h.Anomaly {
			continue
		}
		key := h.DeviceID + "|" + h.VariantID
		if b, ok := best[key]; !ok || h.Bps > b.Bps {
			best[key] = h // history is time-ordered, so first best wins ties
		}
	}
	rows := make([]lbRow, 0, len(best))
	for _, h := range best {
		rows = append(rows, lbRow{historyEntry: h})
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Bps != rows[j].Bps {
			return rows[i].Bps > rows[j].Bps
		}
		return rows[i].EndedAt < rows[j].EndedAt
	})
	for i := range rows {
		rows[i].Rank = i + 1
	}

	s.store.mu.RLock()
	variants := make([]*Variant, 0, len(s.store.variants))
	for _, v := range s.store.variants {
		variants = append(variants, v)
	}
	s.store.mu.RUnlock()
	sort.Slice(variants, func(i, j int) bool { return variants[i].CreatedAt < variants[j].CreatedAt })

	writeJSON(w, map[string]any{
		"rows":     rows,
		"history":  history,
		"variants": variants,
	})
}

func (s *server) handleVariants(w http.ResponseWriter, r *http.Request) {
	s.store.mu.RLock()
	variants := make([]*Variant, 0, len(s.store.variants))
	for _, v := range s.store.variants {
		variants = append(variants, v)
	}
	s.store.mu.RUnlock()
	sort.Slice(variants, func(i, j int) bool { return variants[i].CreatedAt < variants[j].CreatedAt })
	writeJSON(w, map[string]any{"variants": variants})
}

func (s *server) handleRunDetail(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.store.mu.RLock()
	run := s.store.runs[id]
	res := s.store.results[id]
	s.store.mu.RUnlock()
	if run == nil || res == nil {
		httpErr(w, http.StatusNotFound, "unknown run")
		return
	}
	out := map[string]any{"run": run, "result": res}
	if r.URL.Query().Get("keystrokes") == "1" {
		keys, err := s.store.ReadKeystrokes(id)
		if err != nil {
			httpErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		out["keystrokes"] = keys
	}
	writeJSON(w, out)
}

// handleExport: the interchange bundle (spec §4.4). Backup is cp -r data/;
// this is for merge across instances.
func (s *server) handleExport(w http.ResponseWriter, r *http.Request) {
	s.store.mu.RLock()
	variants := make([]*Variant, 0, len(s.store.variants))
	for _, v := range s.store.variants {
		variants = append(variants, v)
	}
	runs := make([]*Run, 0, len(s.store.runs))
	for _, v := range s.store.runs {
		runs = append(runs, v)
	}
	results := make([]*Result, 0, len(s.store.results))
	for _, v := range s.store.results {
		results = append(results, v)
	}
	s.store.mu.RUnlock()
	sort.Slice(variants, func(i, j int) bool { return variants[i].CreatedAt < variants[j].CreatedAt })
	sort.Slice(runs, func(i, j int) bool { return runs[i].StartedAt < runs[j].StartedAt })
	sort.Slice(results, func(i, j int) bool { return results[i].RunID < results[j].RunID })

	out := map[string]any{
		"schema_version": 1,
		"instance_id":    s.store.instanceID,
		"exported_at":    nowRFC3339(),
		"variants":       variants,
		"runs":           runs,
		"results":        results,
	}
	if r.URL.Query().Get("include") == "keystrokes" {
		keys := map[string][]Selection{}
		for _, run := range runs {
			ks, err := s.store.ReadKeystrokes(run.ID)
			if err == nil && len(ks) > 0 {
				keys[run.ID] = ks
			}
		}
		out["keystrokes"] = keys
	}
	writeJSON(w, out)
}
