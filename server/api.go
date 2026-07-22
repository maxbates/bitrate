package main

// JSON API (spec §4.3 endpoints — the step-1 subset):
//
//	POST /api/run/start   -> {run_id, seed, sequence, ...}  (full sequence)
//	POST /api/run/submit  keystroke log -> authoritative result
//
// Scoring is server-recomputed — validation, not authority: timestamps
// originate client-side, so disagreement catches bugs and drift, not
// fabrication (spec §4.3). Leaderboard/gallery/export land in later steps.

import (
	"encoding/json"
	"io/fs"
	"log"
	"math"
	"net/http"
	"sync"
)

type server struct {
	store *Store
	env   fs.FS // environment frontends (embedded, or disk in -dev)
	dev   bool  // -dev: no-store caching so disk edits show up on reload

	mu      sync.Mutex
	pending map[string]*pendingRun // started, not yet submitted
}

type pendingRun struct {
	run     *Run
	cfg     *Config
	symbols []string // canonical per-selection symbols (chars or cell indices)
}

func newServer(store *Store, env fs.FS) *server {
	return &server{store: store, env: env, pending: map[string]*pendingRun{}}
}

func (s *server) routes() *http.ServeMux {
	mux := http.NewServeMux()
	// Lab: / is the environment chooser (grows into the step-6 gallery).
	// Ship: / is the frozen game, straight away.
	if buildProfile == "lab" {
		mux.Handle("GET /{$}", http.RedirectHandler("/env/", http.StatusFound))
	} else {
		mux.Handle("GET /{$}", http.RedirectHandler("/env/stream-typing/", http.StatusFound))
	}
	static := http.StripPrefix("/env/", http.FileServerFS(s.env))
	mux.HandleFunc("GET /env/", func(w http.ResponseWriter, r *http.Request) {
		if s.dev {
			w.Header().Set("Cache-Control", "no-store")
		}
		static.ServeHTTP(w, r)
	})
	mux.HandleFunc("POST /api/run/start", s.handleRunStart)
	mux.HandleFunc("POST /api/run/submit", s.handleRunSubmit)
	s.registerLabRoutes(mux) // empty in ship builds (spec §8)
	return mux
}

// ---- /api/run/start ----

type startReq struct {
	DeviceID   string          `json:"device_id"`
	Config     map[string]any  `json:"config"`
	Scored     bool            `json:"scored"`
	ClientMeta json.RawMessage `json:"client_meta"`
}

type startResp struct {
	RunID        string  `json:"run_id"`
	Seed         string  `json:"seed"`
	Sequence     string  `json:"sequence,omitempty"`      // character alphabets
	SequenceInts []int   `json:"sequence_ints,omitempty"` // numeric alphabets
	ConfigHash   string  `json:"config_hash"`
	N            int     `json:"n"`
	DurationS    float64 `json:"duration_s"`
}

func (s *server) handleRunStart(w http.ResponseWriter, r *http.Request) {
	var req startReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpErr(w, http.StatusBadRequest, "bad json: "+err.Error())
		return
	}
	if len(req.DeviceID) < 8 {
		httpErr(w, http.StatusBadRequest, "device_id required")
		return
	}
	cfg, err := ParseConfig(req.Config)
	if err != nil {
		httpErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.store.PutVariant(&Variant{
		ConfigHash:  cfg.Hash,
		Name:        cfg.Environment, // display label only; identity is the hash
		Config:      cfg.Canonical,
		Environment: cfg.Environment,
		CreatedAt:   nowRFC3339(),
	}); err != nil {
		httpErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	seed, err := NewSeed()
	if err != nil {
		httpErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	runID, err := randHex128()
	if err != nil {
		httpErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	run := &Run{
		ID:             runID,
		VariantID:      cfg.Hash,
		InstanceID:     s.store.instanceID,
		DeviceID:       req.DeviceID,
		Seed:           hexEncode(seed),
		StartedAt:      nowRFC3339(),
		DurationS:      cfg.DurationS,
		IsScored:       req.Scored,
		IsFirstContact: s.store.IsFirstContact(req.DeviceID, cfg.Hash),
		ClientMeta:     req.ClientMeta,
	}
	resp := startResp{
		RunID:      runID,
		Seed:       run.Seed,
		ConfigHash: cfg.Hash,
		N:          cfg.N(),
		DurationS:  cfg.DurationS,
	}
	var symbols []string
	if cfg.AlphabetSize > 0 {
		resp.SequenceInts = GenSequenceInts(seed, cfg.AlphabetSize, SequenceLen)
		symbols = IntSymbols(resp.SequenceInts)
	} else {
		resp.Sequence = GenSequence(seed, cfg.Alphabet, SequenceLen)
		symbols = SplitSymbols(resp.Sequence)
	}
	if err := s.store.PutRun(run, false); err != nil {
		httpErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.mu.Lock()
	s.pending[runID] = &pendingRun{run: run, cfg: cfg, symbols: symbols}
	s.mu.Unlock()

	writeJSON(w, resp)
}

// ---- /api/run/submit ----

type clientResult struct {
	N   int     `json:"n"`
	Sc  int     `json:"sc"`
	Si  int     `json:"si"`
	Bps float64 `json:"bps"`
}

type submitReq struct {
	RunID       string          `json:"run_id"`
	DeviceID    string          `json:"device_id"`
	Invalidated bool            `json:"invalidated"` // focus loss etc. — never scores
	Flags       map[string]bool `json:"flags"`
	ElapsedMs   float64         `json:"elapsed_ms"` // practice bouts; scored runs use duration_s
	Client      *clientResult   `json:"client_result"`
	Keystrokes  []Selection     `json:"keystrokes"`
}

type submitResp struct {
	Result
	Invalidated bool `json:"invalidated"`
}

func (s *server) handleRunSubmit(w http.ResponseWriter, r *http.Request) {
	var req submitReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpErr(w, http.StatusBadRequest, "bad json: "+err.Error())
		return
	}
	s.mu.Lock()
	p := s.pending[req.RunID]
	delete(s.pending, req.RunID)
	s.mu.Unlock()
	if p == nil {
		httpErr(w, http.StatusNotFound, "unknown or already-submitted run")
		return
	}
	if req.DeviceID != p.run.DeviceID {
		httpErr(w, http.StatusForbidden, "device mismatch")
		return
	}

	// Boundary filter: keystrokes with t_pressed < duration count; later
	// ones are ignored (spec §2.5). Applies to scored runs only — practice
	// bouts are open-ended.
	keys := req.Keystrokes
	if p.run.IsScored {
		cut := p.cfg.DurationS * 1000
		kept := keys[:0]
		for _, k := range keys {
			if k.TPressedMs < cut {
				kept = append(kept, k)
			}
		}
		keys = kept
	}

	// Elapsed time: a scored run spans exactly duration_s from the first
	// keypress. Practice elapsed is client-reported, sanity-floored to the
	// last keystroke time.
	var t float64
	if p.run.IsScored {
		t = p.cfg.DurationS
	} else {
		t = req.ElapsedMs / 1000
		if n := len(keys); n > 0 && t < keys[n-1].TPressedMs/1000 {
			t = keys[n-1].TPressedMs / 1000
		}
	}

	sc, si := Replay(p.symbols, keys)
	bits, bps := BitRate(p.cfg.N(), sc, si, t)
	res := &Result{
		RunID:            req.RunID,
		N:                p.cfg.N(),
		Sc:               sc,
		Si:               si,
		BitsPerSelection: bits,
		Bps:              bps,
		TSeconds:         t,
		Metrics:          ComputeMetrics(p.symbols, keys, t),
	}
	// Client/server agreement check — anomalies are bugs or drift, logged
	// never hidden (spec §4.3).
	if req.Client != nil {
		res.ClientBps = req.Client.Bps
		if req.Client.Sc != sc || req.Client.Si != si || req.Client.N != res.N ||
			math.Abs(req.Client.Bps-bps) > 1e-6 {
			res.Anomaly = true
			log.Printf("anomaly: run %s client (N=%d Sc=%d Si=%d bps=%.4f) vs server (N=%d Sc=%d Si=%d bps=%.4f)",
				req.RunID, req.Client.N, req.Client.Sc, req.Client.Si, req.Client.Bps, res.N, sc, si, bps)
		}
	}

	flags := req.Flags
	if flags == nil {
		flags = map[string]bool{}
	}
	if req.Invalidated {
		flags["invalidated"] = true
	}
	if res.Anomaly {
		flags["anomaly"] = true
	}
	p.run.EndedAt = nowRFC3339()
	p.run.Flags = flags

	// Persist: keystroke log, completed run, result — result fsynced before
	// the response returns (spec §4.4).
	if err := s.store.PutKeystrokes(req.RunID, req.Keystrokes); err != nil {
		httpErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.store.PutRun(p.run, true); err != nil {
		httpErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.store.PutResult(res); err != nil {
		httpErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, submitResp{Result: *res, Invalidated: req.Invalidated})
}

// ---- helpers ----

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("write response: %v", err)
	}
}

func httpErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg}) //nolint:errcheck
}
