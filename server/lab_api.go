//go:build !ship

package main

// Lab-only endpoints (spec §4.3, §4.4) — compiled out of ship builds:
//
//	GET /api/leaderboard   rankings + full run history + variant registry
//	GET /api/variants      registry
//	GET /api/runs/{id}     run + result (metrics); ?keystrokes=1 for the log
//	GET /api/export        JSON bundle for backup/merge
//
// The leaderboard is a query, not a table: best bps per (device, variant)
// over scored, completed, verified runs; ties broken by earlier timestamp.
// It derives entirely from run/result, so merging runs merges the
// leaderboard for free (spec §4.4).

import (
	"bufio"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func (s *server) registerLabRoutesImpl(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/leaderboard", s.handleLeaderboard)
	mux.HandleFunc("GET /api/variants", s.handleVariants)
	mux.HandleFunc("GET /api/runs/{id}", s.handleRunDetail)
	mux.HandleFunc("GET /api/export", s.handleExport)
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
		env := ""
		if v := s.store.variants[run.VariantID]; v != nil {
			env = v.Environment
		}
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
		keys, err := s.readKeystrokes(id)
		if err != nil {
			httpErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		out["keystrokes"] = keys
	}
	writeJSON(w, out)
}

func (s *server) readKeystrokes(runID string) ([]Selection, error) {
	f, err := os.Open(filepath.Join(s.store.dir, "keys", runID+".jsonl"))
	if err != nil {
		if os.IsNotExist(err) {
			return []Selection{}, nil
		}
		return nil, err
	}
	defer f.Close()
	var out []Selection
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), 1<<20)
	for sc.Scan() {
		if len(sc.Bytes()) == 0 {
			continue
		}
		var k Selection
		if err := json.Unmarshal(sc.Bytes(), &k); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, sc.Err()
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
			ks, err := s.readKeystrokes(run.ID)
			if err == nil && len(ks) > 0 {
				keys[run.ID] = ks
			}
		}
		out["keystrokes"] = keys
	}
	writeJSON(w, out)
}
