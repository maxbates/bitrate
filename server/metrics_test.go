package main

import (
	"math"
	"testing"
)

func selAt(specs ...struct {
	key string
	t   float64
}) []Selection {
	out := make([]Selection, len(specs))
	for i, s := range specs {
		out[i] = Selection{Index: i, Key: s.key, TPressedMs: s.t}
	}
	return out
}

func TestComputeMetrics(t *testing.T) {
	// seq "abcab": a(0ms ok) z(200 err) Backspace(400 corrects) b(600 ok)
	// c(2500 ok, 1.9s stall) a(2700 ok)
	type ks = struct {
		key string
		t   float64
	}
	keys := selAt(
		ks{"a", 0}, ks{"z", 200}, ks{BackspaceKey, 400},
		ks{"b", 600}, ks{"c", 2500}, ks{"a", 2700},
	)
	m := ComputeMetrics("abcab", keys, 10)

	if m.Selections != 6 || m.Letters != 5 || m.Backspaces != 1 {
		t.Fatalf("counts: %+v", m)
	}
	if m.LetterErrors != 1 || m.Corrected != 1 || m.Uncorrected != 0 || m.BackspaceBad != 0 {
		t.Fatalf("error accounting: %+v", m)
	}
	// Sc = a, bksp, b, c, a = 5; Si = z = 1
	if math.Abs(m.AccuracyPct-100*5.0/6.0) > 1e-9 {
		t.Fatalf("accuracy %v", m.AccuracyPct)
	}
	if m.NetPerS != 0.4 || m.GrossPerS != 0.6 {
		t.Fatalf("rates: net %v gross %v", m.NetPerS, m.GrossPerS)
	}
	if m.StallCount != 1 || m.StallMs != 1900 {
		t.Fatalf("stalls: %d %v", m.StallCount, m.StallMs)
	}
	if len(m.ErrTsMs) != 1 || m.ErrTsMs[0] != 200 {
		t.Fatalf("err timestamps: %v", m.ErrTsMs)
	}
	// Bins: 10s / 5s = 2 bins. Bin 0 covers 0-5s: all 6 selections.
	if len(m.Bins) != 2 || m.Bins[0].Sc != 5 || m.Bins[0].Si != 1 || m.Bins[1].Sc != 0 {
		t.Fatalf("bins: %+v", m.Bins)
	}
	// IKIs: 200,200,200,1900,200 -> median 200, max 1900
	if m.MedianIkiMs != 200 || m.MaxIkiMs != 1900 || m.MinIkiMs != 200 {
		t.Fatalf("iki: median %v min %v max %v", m.MedianIkiMs, m.MinIkiMs, m.MaxIkiMs)
	}
	// Histogram: 4 IKIs in the 200ms bucket (index 2), 1 in overflow (1900 -> idx 15)
	if m.IkiHist[2] != 4 || m.IkiHist[15] != 1 {
		t.Fatalf("hist: %v", m.IkiHist)
	}
	if m.DeadTailMs != 10000-2700 {
		t.Fatalf("dead tail %v", m.DeadTailMs)
	}
}

func TestComputeMetricsEmpty(t *testing.T) {
	m := ComputeMetrics("abc", nil, 60)
	if m.Selections != 0 || m.StallCount != 0 || len(m.Bins) != 12 {
		t.Fatalf("%+v", m)
	}
}

// Metrics replay must agree with the scoring replay on every log.
func TestMetricsAgreesWithReplay(t *testing.T) {
	seed, _ := NewSeed()
	seq := GenSequence(seed, lowercase, 400)
	keys := syntheticKeystrokes(seq, 300, 150)
	sc, si := Replay(seq, keys)
	tSec := keys[len(keys)-1].TPressedMs / 1000
	m := ComputeMetrics(seq, keys, tSec)
	gotSc := 0
	for _, b := range m.Bins {
		gotSc += b.Sc
	}
	if gotSc != sc || m.Selections-gotSc != si {
		t.Fatalf("metrics Sc=%d Si=%d, replay Sc=%d Si=%d", gotSc, m.Selections-gotSc, sc, si)
	}
}
