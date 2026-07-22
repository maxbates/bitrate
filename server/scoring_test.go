package main

import (
	"math"
	"testing"
)

func sel(keys ...string) []Selection {
	out := make([]Selection, len(keys))
	for i, k := range keys {
		out[i] = Selection{Index: i, Key: k, TPressedMs: float64(i * 100)}
	}
	return out
}

func TestReplay(t *testing.T) {
	const seq = "abcab"
	cases := []struct {
		name   string
		keys   []Selection
		sc, si int
	}{
		{"empty", nil, 0, 0},
		{"all correct", sel("a", "b", "c", "a", "b"), 5, 0},
		{"all wrong", sel("z", "z", "z"), 0, 3},
		{"advance always: wrong consumes target", sel("z", "b"), 1, 1},

		// Backspace semantics (spec §2.4): correct iff it deletes an
		// uncorrected error immediately behind the cursor.
		{"miss -> backspace -> retype nets +1", sel("z", BackspaceKey, "a"), 2, 1},
		{"backspace of a correct char scores Si", sel("a", BackspaceKey), 1, 1},
		{"backspace at position 0 scores Si", sel(BackspaceKey), 0, 1},
		{"chained backspaces walk back a trailing error run",
			sel("z", "z", BackspaceKey, BackspaceKey, "a", "b"), 4, 2},
		{"backspace past errors into correct territory",
			sel("a", "z", BackspaceKey, BackspaceKey, "a", "b"), 4, 2},
		{"retype after backspace can err again",
			sel("z", BackspaceKey, "q", BackspaceKey, "a"), 3, 2},

		// The no-exploit checks from §2.4.
		{"deliberate err+correct is worse than typing correctly",
			// err, bksp, retype = +1 net over 3 keys; typing 3 correct = +3.
			sel("z", BackspaceKey, "a"), 2, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sc, si := Replay(SplitSymbols(seq), c.keys)
			if sc != c.sc || si != c.si {
				t.Fatalf("got Sc=%d Si=%d, want Sc=%d Si=%d", sc, si, c.sc, c.si)
			}
		})
	}
}

func TestBitRate(t *testing.T) {
	// Reference values computed independently: B = log2(N-1)*max(Sc-Si,0)/t.
	cases := []struct {
		n, sc, si int
		t         float64
		wantBits  float64
		wantBps   float64
	}{
		{27, 300, 0, 60, math.Log2(26), math.Log2(26) * 300 / 60},
		{27, 250, 10, 60, math.Log2(26), math.Log2(26) * 240 / 60},
		{27, 10, 50, 60, math.Log2(26), 0},                 // net clamped at 0
		{27, 100, 0, 0, math.Log2(26), 0},                  // t=0: HUD reads 0.0, no div-by-zero
		{30, 120, 0, 60, math.Log2(29), math.Log2(29) * 2}, // the brief's own example N
		{2, 100, 0, 60, 0, 0},                              // N < 3 invalid
	}
	for _, c := range cases {
		bits, bps := BitRate(c.n, c.sc, c.si, c.t)
		if math.Abs(bits-c.wantBits) > 1e-12 || math.Abs(bps-c.wantBps) > 1e-12 {
			t.Errorf("BitRate(%d,%d,%d,%v) = (%v, %v), want (%v, %v)",
				c.n, c.sc, c.si, c.t, bits, bps, c.wantBits, c.wantBps)
		}
	}
}

// TestReplayIgnoresClientVerdicts: server recomputes from key identities
// only — a lying client verdict changes nothing (spec §4.3).
func TestReplayIgnoresClientVerdicts(t *testing.T) {
	keys := sel("z", "z")
	for i := range keys {
		keys[i].Verdict = true // client claims correct
	}
	sc, si := Replay(SplitSymbols("ab"), keys)
	if sc != 0 || si != 2 {
		t.Fatalf("got Sc=%d Si=%d, want 0/2", sc, si)
	}
}
