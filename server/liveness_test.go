package main

// Liveness regression tests. These exist because the deployed site is the whole
// deliverable (spec §8): a request that fails is acceptable, a request that
// kills the process is not. Each test here pins a specific way the process could
// previously be taken down by an unauthenticated request.

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// ComputeMetrics allocates its pace bins from tSec *before* any guard runs, so
// an unbounded tSec was an unbounded make() — billions of bins, and a runtime
// out-of-memory throw, which (unlike a panic) net/http's per-connection recover
// cannot contain. Verified here for the values that actually reached it: a
// client-supplied duration_s and a client-supplied practice elapsed_ms.
func TestComputeMetricsBoundsPaceBins(t *testing.T) {
	for _, tSec := range []float64{
		0, -1, 1, 60, 600,
		1e6, 1e10, // the lethal middle band: well-defined int conversions
		1e19, 1e30, // past int64 range, where int(float64) wraps negative
		math.NaN(), math.Inf(1), math.Inf(-1),
	} {
		m := ComputeMetrics(nil, nil, tSec)
		if m == nil {
			t.Fatalf("tSec=%g: nil metrics", tSec)
		}
		if len(m.Bins) < 1 || len(m.Bins) > MaxPaceBins {
			t.Errorf("tSec=%g: %d bins, want 1..%d", tSec, len(m.Bins), MaxPaceBins)
		}
		if len(m.IkiHist) != IkiHistBuckets {
			t.Errorf("tSec=%g: %d iki buckets, want %d", tSec, len(m.IkiHist), IkiHistBuckets)
		}
	}
}

// A real 60 s run must still get full resolution — the clamp is a backstop, not
// a behaviour change.
func TestComputeMetricsKeepsRealRunResolution(t *testing.T) {
	m := ComputeMetrics(nil, nil, 60)
	if want := 60 / BinSeconds; len(m.Bins) != want {
		t.Errorf("60 s run: %d bins, want %d", len(m.Bins), want)
	}
}

// The allocation above is defence in depth; this is the front door. An
// unbounded duration_s must never be accepted in the first place.
func TestParseConfigBoundsDuration(t *testing.T) {
	cfgWith := func(d any) map[string]any {
		return map[string]any{"environment": "test", "alphabet": "abc", "backspace": true, "duration_s": d}
	}
	for _, bad := range []any{0.0, -1.0, MaxDurationS + 1, 1e10, math.NaN(), math.Inf(1)} {
		if _, err := ParseConfig(cfgWith(bad)); err == nil {
			t.Errorf("duration_s=%v was accepted, want rejection", bad)
		}
	}
	for _, good := range []any{1.0, 60.0, MaxDurationS} {
		if _, err := ParseConfig(cfgWith(good)); err != nil {
			t.Errorf("duration_s=%v was rejected: %v", good, err)
		}
	}
}

// A truncated final line is exactly the damage a crash or a full disk leaves
// behind, and refusing to boot on it turned one lost run into a permanent
// outage (systemd Restart=always → 10 s crash loop). Every readable record must
// still load.
func TestLoadJSONLSkipsCorruptLines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runs.jsonl")
	body := `{"id":"aaa"}` + "\n" +
		`{"id":"bbb"}` + "\n" +
		`{"id":"ccc"` + "\n" + // truncated mid-object, as a killed append leaves it
		`{"id":"ddd"}` + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	var got []string
	if err := loadJSONL(path, func(r *Run) { got = append(got, r.ID) }); err != nil {
		t.Fatalf("loadJSONL returned an error on a corrupt line: %v", err)
	}
	want := []string{"aaa", "bbb", "ddd"}
	if len(got) != len(want) {
		t.Fatalf("loaded %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("loaded %v, want %v", got, want)
		}
	}
}

// A store whose ledger took damage must still open, not fail startup.
func TestOpenStoreSurvivesCorruptLedger(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "keys"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "runs.jsonl"), []byte("{\"id\":\"ok\"}\n{\"id\":\"trunc\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := OpenStore(dir)
	if err != nil {
		t.Fatalf("OpenStore failed on a damaged ledger: %v", err)
	}
	if runs, _, _ := st.Counts(); runs != 1 {
		t.Errorf("loaded %d runs, want 1 (the readable one)", runs)
	}
}

// Abandoned runs are routine (closed tab, reload), and each pending entry
// retains a config document plus a full symbol sequence. Unbounded growth here
// ends in a fatal OOM, so the map must evict.
func TestPendingSweepEvictsAbandonedRuns(t *testing.T) {
	s := newServer(nil, nil)
	// Expired by TTL.
	s.pending["old"] = &pendingRun{startedAt: time.Now().Add(-2 * pendingTTL)}
	s.pending["fresh"] = &pendingRun{startedAt: time.Now()}
	s.mu.Lock()
	s.sweepPendingLocked()
	s.mu.Unlock()
	if _, ok := s.pending["old"]; ok {
		t.Error("expired pending run was not swept")
	}
	if _, ok := s.pending["fresh"]; !ok {
		t.Error("fresh pending run was swept")
	}

	// Burst faster than the TTL: the cap still has to hold.
	for i := 0; i < maxPending*2; i++ {
		s.mu.Lock()
		s.sweepPendingLocked()
		s.pending[fmt.Sprintf("r%d", i)] = &pendingRun{startedAt: time.Now()}
		s.mu.Unlock()
	}
	if len(s.pending) > maxPending {
		t.Errorf("pending grew to %d, want <= %d", len(s.pending), maxPending)
	}
}
