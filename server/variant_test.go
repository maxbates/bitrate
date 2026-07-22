package main

import (
	"encoding/json"
	"testing"
)

func defaultConfig() map[string]any {
	return map[string]any{
		"environment":    "stream-typing",
		"alphabet":       "abcdefghijklmnopqrstuvwxyz",
		"lookahead":      float64(8),
		"fixation":       "pinned",
		"chunk_size":     nil,
		"audio_feedback": false,
		"error_policy":   "advance",
		"backspace":      true,
		"duration_s":     float64(60),
		"hud_position":   "corner",
		"font_stack":     "system-mono",
	}
}

func TestParseConfig(t *testing.T) {
	cfg, err := ParseConfig(defaultConfig())
	if err != nil {
		t.Fatal(err)
	}
	if cfg.N() != 27 {
		t.Fatalf("N = %d, want 27 (26 letters + backspace)", cfg.N())
	}
	if cfg.DurationS != 60 {
		t.Fatalf("duration = %v", cfg.DurationS)
	}
	withChunk := defaultConfig()
	withChunk["chunk_size"] = float64(5)
	if _, err := ParseConfig(withChunk); err != nil {
		t.Fatalf("chunk_size 5 rejected: %v", err)
	}
}

// Content addressing (spec §4.4): same config -> same hash regardless of
// key order or whitespace in transit; any semantic change -> new hash.
func TestConfigHashCanonical(t *testing.T) {
	a, err := ParseConfig(defaultConfig())
	if err != nil {
		t.Fatal(err)
	}
	// Round-trip through JSON (different map iteration, same content).
	var raw map[string]any
	if err := json.Unmarshal(a.Canonical, &raw); err != nil {
		t.Fatal(err)
	}
	b, err := ParseConfig(raw)
	if err != nil {
		t.Fatal(err)
	}
	if a.Hash != b.Hash {
		t.Fatalf("identical configs hash differently: %s vs %s", a.Hash, b.Hash)
	}

	changed := defaultConfig()
	changed["lookahead"] = float64(9)
	c, err := ParseConfig(changed)
	if err != nil {
		t.Fatal(err)
	}
	if c.Hash == a.Hash {
		t.Fatal("changed config kept the same hash")
	}
}

func TestParseConfigRejects(t *testing.T) {
	bad := []func(m map[string]any){
		func(m map[string]any) { m["alphabet"] = "" },
		func(m map[string]any) { m["alphabet"] = "aab" },    // duplicate symbol
		func(m map[string]any) { m["alphabet"] = "ab\x01" }, // non-printable
		func(m map[string]any) { delete(m, "environment") },
		func(m map[string]any) { m["duration_s"] = float64(0) },
		func(m map[string]any) { m["alphabet"] = "ab"; m["backspace"] = false }, // N=2 < 3
		func(m map[string]any) { m["chunk_size"] = float64(1) },                 // chunking needs >= 2
		func(m map[string]any) { m["chunk_size"] = "5" },                        // must be a number
	}
	for i, mutate := range bad {
		m := defaultConfig()
		mutate(m)
		if _, err := ParseConfig(m); err == nil {
			t.Errorf("case %d: config accepted, want error", i)
		}
	}
}
