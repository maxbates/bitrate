package main

// Persistence (spec §4.4): append-only JSONL, no database.
//
//	data/variants.jsonl        one line per variant registration
//	data/runs.jsonl            run records; a run appears once at start and
//	                           again at submit — the loader is last-wins by id
//	data/results.jsonl         server-authoritative results
//	data/keys/<run_id>.jsonl   keystroke log, written once at submit
//	data/instance_id           random id minted on first start (provenance)
//
// The small files load into memory at boot; keystroke bulk stays on disk.
// A single writer goroutine serializes appends, and a completed run is
// fsynced before the submit response returns.

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Run is the run record (spec §4.3 data model).
type Run struct {
	ID             string          `json:"id"` // random 128-bit hex — never autoincrement
	VariantID      string          `json:"variant_id"`
	InstanceID     string          `json:"instance_id"`
	DeviceID       string          `json:"device_id"`
	Seed           string          `json:"seed"`
	StartedAt      string          `json:"started_at"`
	EndedAt        string          `json:"ended_at,omitempty"`
	DurationS      float64         `json:"duration_s"`
	IsScored       bool            `json:"is_scored"`
	IsFirstContact bool            `json:"is_first_contact"`
	Flags          map[string]bool `json:"flags,omitempty"` // bot-heuristic / anomaly / invalidated
	ClientMeta     json.RawMessage `json:"client_meta,omitempty"`
}

// Variant is the variant registry record.
type Variant struct {
	ConfigHash  string          `json:"config_hash"`
	Name        string          `json:"name"`
	Config      json.RawMessage `json:"config"`
	Environment string          `json:"environment"`
	CreatedAt   string          `json:"created_at"`
}

// Result is the server-authoritative result record.
type Result struct {
	RunID            string  `json:"run_id"`
	N                int     `json:"n"`
	Sc               int     `json:"sc"`
	Si               int     `json:"si"`
	BitsPerSelection float64 `json:"bits_per_selection"`
	Bps              float64 `json:"bps"`
	TSeconds         float64 `json:"t_seconds"`
	ClientBps        float64 `json:"client_bps"` // for drift analysis
	Anomaly          bool    `json:"anomaly"`    // client/server disagreement beyond tolerance

	// Server-computed diagnostics (see metrics.go). Comparable across
	// environments because they derive from the standard selection log.
	Metrics *Metrics `json:"metrics,omitempty"`
}

type appendReq struct {
	file string // relative to data dir
	line []byte
	sync bool
	done chan error
}

// Store owns the data directory. All appends flow through a single writer
// goroutine; the in-memory maps are the read model.
type Store struct {
	dir        string
	instanceID string

	mu       sync.RWMutex
	runs     map[string]*Run
	variants map[string]*Variant
	results  map[string]*Result

	appendCh chan appendReq
	files    map[string]*os.File // writer-goroutine-only
}

func OpenStore(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "keys"), 0o755); err != nil {
		return nil, err
	}
	s := &Store{
		dir:      dir,
		runs:     map[string]*Run{},
		variants: map[string]*Variant{},
		results:  map[string]*Result{},
		appendCh: make(chan appendReq, 64),
		files:    map[string]*os.File{},
	}
	if err := s.loadInstanceID(); err != nil {
		return nil, err
	}
	if err := loadJSONL(filepath.Join(dir, "variants.jsonl"), func(v *Variant) { s.variants[v.ConfigHash] = v }); err != nil {
		return nil, err
	}
	if err := loadJSONL(filepath.Join(dir, "runs.jsonl"), func(r *Run) { s.runs[r.ID] = r }); err != nil {
		return nil, err
	}
	if err := loadJSONL(filepath.Join(dir, "results.jsonl"), func(r *Result) { s.results[r.RunID] = r }); err != nil {
		return nil, err
	}
	go s.writer()
	return s, nil
}

// Counts reports the loaded record counts — for the startup ledger banner.
func (s *Store) Counts() (runs, results, variants int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.runs), len(s.results), len(s.variants)
}

func (s *Store) loadInstanceID() error {
	path := filepath.Join(s.dir, "instance_id")
	b, err := os.ReadFile(path)
	if err == nil && len(b) >= 32 {
		s.instanceID = string(b[:32])
		return nil
	}
	id, err := randHex128()
	if err != nil {
		return err
	}
	s.instanceID = id
	return os.WriteFile(path, []byte(id), 0o644)
}

// loadJSONL reads a JSONL file line by line; missing files are fine.
// Later lines win (append-only update convention).
func loadJSONL[T any](path string, add func(*T)) error {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1<<20), 1<<20)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		v := new(T)
		if err := json.Unmarshal(line, v); err != nil {
			return fmt.Errorf("%s: corrupt line: %w", path, err)
		}
		add(v)
	}
	return sc.Err()
}

func (s *Store) writer() {
	for req := range s.appendCh {
		req.done <- s.doAppend(req)
	}
}

func (s *Store) doAppend(req appendReq) error {
	f, ok := s.files[req.file]
	if !ok {
		var err error
		f, err = os.OpenFile(filepath.Join(s.dir, req.file), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			return err
		}
		s.files[req.file] = f
	}
	if req.line != nil { // nil line = sync-only request
		if _, err := f.Write(append(req.line, '\n')); err != nil {
			return err
		}
	}
	if req.sync {
		return f.Sync()
	}
	return nil
}

func (s *Store) append(file string, v any, sync bool) error {
	line, err := json.Marshal(v)
	if err != nil {
		return err
	}
	done := make(chan error, 1)
	s.appendCh <- appendReq{file: file, line: line, sync: sync, done: done}
	return <-done
}

// PutVariant registers a variant if its config hash is new (idempotent).
func (s *Store) PutVariant(v *Variant) error {
	s.mu.Lock()
	if _, exists := s.variants[v.ConfigHash]; exists {
		s.mu.Unlock()
		return nil
	}
	s.variants[v.ConfigHash] = v
	s.mu.Unlock()
	return s.append("variants.jsonl", v, false)
}

// PutRun appends a run record (at start, and again at submit with EndedAt
// set — the loader is last-wins). fsync only on the completed record.
func (s *Store) PutRun(r *Run, sync bool) error {
	s.mu.Lock()
	s.runs[r.ID] = r
	s.mu.Unlock()
	return s.append("runs.jsonl", r, sync)
}

// PutResult appends a result, fsynced before the submit response returns.
func (s *Store) PutResult(r *Result) error {
	s.mu.Lock()
	s.results[r.RunID] = r
	s.mu.Unlock()
	return s.append("results.jsonl", r, true)
}

// PutKeystrokes writes the full keystroke log for a run, one JSONL line per
// selection, written once at submit and read lazily (spec §4.4).
func (s *Store) PutKeystrokes(runID string, keys []Selection) error {
	for _, k := range keys {
		if err := s.append(filepath.Join("keys", runID+".jsonl"), k, false); err != nil {
			return err
		}
	}
	// fsync the completed log before the submit response returns.
	done := make(chan error, 1)
	s.appendCh <- appendReq{file: filepath.Join("keys", runID+".jsonl"), line: nil, sync: true, done: done}
	<-done
	return nil
}

// ReadKeystrokes reads a run's keystroke log back off disk — the mirror of
// PutKeystrokes, and the only path that faults the bulk in. A run with no log
// (never submitted, or merged from an instance that withheld it) reads as
// empty, not as an error.
func (s *Store) ReadKeystrokes(runID string) ([]Selection, error) {
	f, err := os.Open(filepath.Join(s.dir, "keys", runID+".jsonl"))
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

// GetRun returns the run record, or nil.
func (s *Store) GetRun(id string) *Run {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.runs[id]
}

// IsFirstContact reports whether device has no prior run on variant
// (spec §3: first-contact scores are precious — log them distinctly).
func (s *Store) IsFirstContact(deviceID, variantID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, r := range s.runs {
		if r.DeviceID == deviceID && r.VariantID == variantID {
			return false
		}
	}
	return true
}

func randHex128() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func nowRFC3339() string { return time.Now().UTC().Format(time.RFC3339Nano) }
