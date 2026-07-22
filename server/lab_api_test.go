//go:build !ship

package main

import (
	"encoding/json"
	"net/http"
	"testing"
)

func getJSON[T any](t *testing.T, url string) T {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("GET %s: %d", url, resp.StatusCode)
	}
	var out T
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

type lbResp struct {
	Rows     []lbRow        `json:"rows"`
	History  []historyEntry `json:"history"`
	Variants []*Variant     `json:"variants"`
}

// playRun drives a full scored run through the API with a real-looking UA.
func playRun(t *testing.T, ts string, device string, count int, iki float64) {
	t.Helper()
	start := postJSON[startResp](t, ts+"/api/run/start", startReq{
		DeviceID:   device,
		Config:     defaultConfig(),
		Scored:     true,
		ClientMeta: json.RawMessage(`{"ua":"Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0"}`),
	})
	keys := syntheticKeystrokes(start.Sequence, count, iki)
	postJSON[submitResp](t, ts+"/api/run/submit", submitReq{
		RunID: start.RunID, DeviceID: device, Keystrokes: keys,
	})
}

func TestLeaderboard(t *testing.T) {
	_, ts := newTestServer(t)

	// Two devices; device A plays twice (improving), device B once.
	playRun(t, ts.URL, "aaaa111122223333", 100, 400) // A, slower
	playRun(t, ts.URL, "aaaa111122223333", 200, 250) // A, faster (their best)
	playRun(t, ts.URL, "bbbb111122223333", 150, 300) // B

	// A headless/synthetic run must stay out of the rankings (spec §7).
	start := postJSON[startResp](t, ts.URL+"/api/run/start", startReq{
		DeviceID:   "cccc111122223333",
		Config:     defaultConfig(),
		Scored:     true,
		ClientMeta: json.RawMessage(`{"ua":"HeadlessChrome/145.0"}`),
	})
	postJSON[submitResp](t, ts.URL+"/api/run/submit", submitReq{
		RunID: start.RunID, DeviceID: "cccc111122223333",
		Keystrokes: syntheticKeystrokes(start.Sequence, 400, 120), // fast bot
	})

	lb := getJSON[lbResp](t, ts.URL+"/api/leaderboard")

	// Best per (device, variant): one row each for A and B, none for the bot.
	if len(lb.Rows) != 2 {
		t.Fatalf("rows = %d, want 2 (bot excluded): %+v", len(lb.Rows), lb.Rows)
	}
	if lb.Rows[0].Bps < lb.Rows[1].Bps {
		t.Fatal("rows not ranked by bps")
	}
	if lb.Rows[0].Rank != 1 || lb.Rows[1].Rank != 2 {
		t.Fatal("ranks wrong")
	}
	for _, row := range lb.Rows {
		if row.DeviceID == "cccc111122223333" {
			t.Fatal("headless run ranked")
		}
		if row.Pseudonym == "" || row.Environment != "stream-typing" {
			t.Fatalf("row missing display fields: %+v", row)
		}
	}
	// History includes everything (verified flag distinguishes), 4 runs.
	if len(lb.History) != 4 {
		t.Fatalf("history = %d, want 4", len(lb.History))
	}
	verified := 0
	for _, h := range lb.History {
		if h.Verified {
			verified++
		}
	}
	if verified != 3 {
		t.Fatalf("verified = %d, want 3", verified)
	}
	if len(lb.Variants) != 1 {
		t.Fatalf("variants = %d, want 1", len(lb.Variants))
	}
}

func TestRunDetailAndExport(t *testing.T) {
	_, ts := newTestServer(t)
	playRun(t, ts.URL, "aaaa111122223333", 80, 300)

	lb := getJSON[lbResp](t, ts.URL+"/api/leaderboard")
	if len(lb.Rows) != 1 {
		t.Fatalf("rows = %d", len(lb.Rows))
	}
	id := lb.Rows[0].RunID

	detail := getJSON[map[string]json.RawMessage](t, ts.URL+"/api/runs/"+id)
	var res Result
	if err := json.Unmarshal(detail["result"], &res); err != nil {
		t.Fatal(err)
	}
	if res.Metrics == nil || res.Metrics.Selections == 0 {
		t.Fatal("detail result missing metrics")
	}

	withKeys := getJSON[map[string]json.RawMessage](t, ts.URL+"/api/runs/"+id+"?keystrokes=1")
	var keys []Selection
	if err := json.Unmarshal(withKeys["keystrokes"], &keys); err != nil {
		t.Fatal(err)
	}
	if len(keys) == 0 {
		t.Fatal("no keystrokes in detail")
	}

	export := getJSON[map[string]json.RawMessage](t, ts.URL+"/api/export?include=keystrokes")
	var schema int
	json.Unmarshal(export["schema_version"], &schema) //nolint:errcheck
	if schema != 1 {
		t.Fatalf("schema_version = %d", schema)
	}
	var runs []Run
	if err := json.Unmarshal(export["runs"], &runs); err != nil || len(runs) != 1 {
		t.Fatalf("export runs: %v / %d", err, len(runs))
	}
	var ksMap map[string][]Selection
	if err := json.Unmarshal(export["keystrokes"], &ksMap); err != nil || len(ksMap[id]) == 0 {
		t.Fatalf("export keystrokes: %v", err)
	}
}
