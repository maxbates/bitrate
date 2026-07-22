package main

// End-to-end synthetic run (spec §3a): a scripted player drives the real
// API — start → keystrokes → submit — and the server's result is checked
// against an independent reference implementation written in this test.
// It answers "is it correct," never "is it better."

import (
	"bytes"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func newTestServer(t *testing.T) (*server, *httptest.Server) {
	t.Helper()
	store, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	srv := newServer(store, os.DirFS("../environments"))
	ts := httptest.NewServer(srv.routes())
	t.Cleanup(ts.Close)
	return srv, ts
}

func postJSON[T any](t *testing.T, url string, body any) T {
	t.Helper()
	b, _ := json.Marshal(body)
	resp, err := http.Post(url, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		var e map[string]string
		json.NewDecoder(resp.Body).Decode(&e) //nolint:errcheck
		t.Fatalf("POST %s: %d %v", url, resp.StatusCode, e)
	}
	var out T
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

// referenceScore is an independent scorer: simple, readable, written from
// the formula in the brief — not from scoring.go.
func referenceScore(seq string, keys []Selection, n int, tSec float64) (sc, si int, bps float64) {
	var typed []struct {
		ok bool
	}
	cursor := 0
	for _, k := range keys {
		if k.Key == "Backspace" {
			if cursor == 0 {
				si++
				continue
			}
			if !typed[cursor-1].ok {
				sc++
			} else {
				si++
			}
			cursor--
			typed = typed[:cursor]
			continue
		}
		ok := k.Key == string(seq[cursor])
		if ok {
			sc++
		} else {
			si++
		}
		typed = append(typed, struct{ ok bool }{ok})
		cursor++
	}
	net := float64(sc - si)
	if net < 0 {
		net = 0
	}
	return sc, si, math.Log2(float64(n-1)) * net / tSec
}

// syntheticKeystrokes types the sequence at a fixed cadence: every 7th
// selection errs and is corrected (miss → backspace → retype), every 23rd
// errs and is left uncorrected.
func syntheticKeystrokes(seq string, count int, ikiMs float64) []Selection {
	var keys []Selection
	tms := 0.0
	press := func(key string) {
		keys = append(keys, Selection{Index: len(keys), Key: key, TPressedMs: tms})
		tms += ikiMs
	}
	wrongFor := func(c byte) string {
		if c == 'a' {
			return "b"
		}
		return "a"
	}
	for i := 0; i < count; i++ {
		c := seq[i]
		switch {
		case (i+1)%23 == 0:
			press(wrongFor(c)) // uncorrected error
		case (i+1)%7 == 0:
			press(wrongFor(c)) // miss
			press("Backspace") // correct the miss
			press(string(c))   // retype
		default:
			press(string(c))
		}
	}
	return keys
}

func TestScoredRunEndToEnd(t *testing.T) {
	srv, ts := newTestServer(t)

	start := postJSON[startResp](t, ts.URL+"/api/run/start", startReq{
		DeviceID: "deadbeefdeadbeef",
		Config:   defaultConfig(),
		Scored:   true,
	})
	if start.N != 27 {
		t.Fatalf("N = %d, want 27", start.N)
	}
	if len(start.Sequence) != SequenceLen {
		t.Fatalf("sequence length %d", len(start.Sequence))
	}

	// ~5 selections/sec, deliberately overrunning the 60 s boundary — the
	// reference applies the same t < 60000 cut the server must apply.
	all := syntheticKeystrokes(start.Sequence, 280, 190)
	var inWindow []Selection
	for _, k := range all {
		if k.TPressedMs < 60000 {
			inWindow = append(inWindow, k)
		}
	}
	if len(inWindow) == len(all) {
		t.Fatal("test setup: no keystrokes past the boundary — boundary filter untested")
	}

	refSc, refSi, refBps := referenceScore(start.Sequence, inWindow, 27, 60)

	res := postJSON[submitResp](t, ts.URL+"/api/run/submit", submitReq{
		RunID:      start.RunID,
		DeviceID:   "deadbeefdeadbeef",
		Client:     &clientResult{N: 27, Sc: refSc, Si: refSi, Bps: refBps},
		Keystrokes: all,
	})

	if res.Sc != refSc || res.Si != refSi {
		t.Fatalf("server Sc=%d Si=%d, reference Sc=%d Si=%d", res.Sc, res.Si, refSc, refSi)
	}
	if math.Abs(res.Bps-refBps) > 1e-9 {
		t.Fatalf("server bps %v, reference %v", res.Bps, refBps)
	}
	if res.Anomaly {
		t.Fatal("agreeing client result flagged as anomaly")
	}
	if res.TSeconds != 60 {
		t.Fatalf("t = %v, want exactly 60", res.TSeconds)
	}

	// Diagnostics ride the result (spec §4.3): consistent with the score.
	m := res.Metrics
	if m == nil {
		t.Fatal("no metrics on result")
	}
	if m.Selections != len(inWindow) {
		t.Fatalf("metrics selections %d, want %d", m.Selections, len(inWindow))
	}
	binSc := 0
	for _, b := range m.Bins {
		binSc += b.Sc
	}
	if binSc != refSc || len(m.Bins) != 12 {
		t.Fatalf("metrics bins Sc=%d (want %d), %d bins", binSc, refSc, len(m.Bins))
	}
	if m.Corrected == 0 || m.Uncorrected == 0 {
		t.Fatal("synthetic run has both corrected and uncorrected misses; metrics disagree")
	}

	// Persisted: run completed, result stored, keystroke log on disk.
	if r := srv.store.GetRun(start.RunID); r == nil || r.EndedAt == "" {
		t.Fatal("run not completed in store")
	}
	if _, err := os.Stat(filepath.Join(srv.store.dir, "keys", start.RunID+".jsonl")); err != nil {
		t.Fatalf("keystroke log missing: %v", err)
	}
}

func TestSubmitDisagreementFlagsAnomaly(t *testing.T) {
	_, ts := newTestServer(t)
	start := postJSON[startResp](t, ts.URL+"/api/run/start", startReq{
		DeviceID: "deadbeefdeadbeef",
		Config:   defaultConfig(),
		Scored:   true,
	})
	keys := syntheticKeystrokes(start.Sequence, 50, 100)
	res := postJSON[submitResp](t, ts.URL+"/api/run/submit", submitReq{
		RunID:      start.RunID,
		DeviceID:   "deadbeefdeadbeef",
		Client:     &clientResult{N: 27, Sc: 9999, Si: 0, Bps: 999}, // lying client
		Keystrokes: keys,
	})
	if !res.Anomaly {
		t.Fatal("disagreeing client result not flagged")
	}
}

func TestSubmitUnknownRun(t *testing.T) {
	_, ts := newTestServer(t)
	b, _ := json.Marshal(submitReq{RunID: "nope", DeviceID: "deadbeefdeadbeef"})
	resp, err := ts.Client().Post(ts.URL+"/api/run/submit", "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("status %d, want 404", resp.StatusCode)
	}
}

func TestDoubleSubmitRejected(t *testing.T) {
	_, ts := newTestServer(t)
	start := postJSON[startResp](t, ts.URL+"/api/run/start", startReq{
		DeviceID: "deadbeefdeadbeef",
		Config:   defaultConfig(),
		Scored:   false,
	})
	req := submitReq{
		RunID:      start.RunID,
		DeviceID:   "deadbeefdeadbeef",
		ElapsedMs:  10000,
		Keystrokes: syntheticKeystrokes(start.Sequence, 30, 150),
	}
	postJSON[submitResp](t, ts.URL+"/api/run/submit", req)
	b, _ := json.Marshal(req)
	resp, err := ts.Client().Post(ts.URL+"/api/run/submit", "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("double submit: status %d, want 404", resp.StatusCode)
	}
}

func TestFirstContactTracking(t *testing.T) {
	srv, ts := newTestServer(t)
	s1 := postJSON[startResp](t, ts.URL+"/api/run/start", startReq{
		DeviceID: "deadbeefdeadbeef", Config: defaultConfig(),
	})
	if r := srv.store.GetRun(s1.RunID); !r.IsFirstContact {
		t.Fatal("first run not marked first-contact")
	}
	s2 := postJSON[startResp](t, ts.URL+"/api/run/start", startReq{
		DeviceID: "deadbeefdeadbeef", Config: defaultConfig(),
	})
	if r := srv.store.GetRun(s2.RunID); r.IsFirstContact {
		t.Fatal("second run on same variant marked first-contact")
	}
}
