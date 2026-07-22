package main

// Per-run diagnostic metrics, server-computed from the selection log at
// submit. Because every environment emits the same log schema (§5 contract),
// these numbers are directly comparable across modalities — the same
// "where did the bits go" breakdown for keyboard, webcam, or chords.
// Stored on the result record; rendered by the results view and, later,
// the gallery.

import (
	"math"
	"sort"
)

// StallThresholdMs: an inter-selection interval this long is a stall — the
// player was deciding, not executing. 1.5 s is ~3x a slow-but-moving IKI.
const StallThresholdMs = 1500

// BinSeconds is the pace-chart bin width.
const BinSeconds = 5

// PaceBin is one time slice of the run.
type PaceBin struct {
	Sc int `json:"sc"`
	Si int `json:"si"`
}

// IkiHistBuckets: 100 ms buckets 0–1500 ms, plus one overflow bucket.
const IkiHistBuckets = 16

type Metrics struct {
	Selections int     `json:"selections"`
	GrossPerS  float64 `json:"gross_per_s"` // selections / t
	NetPerS    float64 `json:"net_per_s"`   // (Sc - Si) / t, unclamped

	Letters      int     `json:"letters"`
	Backspaces   int     `json:"backspaces"`
	LetterErrors int     `json:"letter_errors"`
	Corrected    int     `json:"corrected"`     // errors deleted by a correct backspace
	Uncorrected  int     `json:"uncorrected"`   // letter_errors - corrected
	BackspaceBad int     `json:"backspace_bad"` // backspaces judged incorrect
	AccuracyPct  float64 `json:"accuracy_pct"`  // correct selections / selections

	MedianIkiMs float64 `json:"median_iki_ms"`
	MeanIkiMs   float64 `json:"mean_iki_ms"`
	P90IkiMs    float64 `json:"p90_iki_ms"`
	MinIkiMs    float64 `json:"min_iki_ms"`
	MaxIkiMs    float64 `json:"max_iki_ms"`

	StallCount int     `json:"stall_count"`
	StallMs    float64 `json:"stall_ms"`
	DeadTailMs float64 `json:"dead_tail_ms"` // t end minus last keystroke

	Bins    []PaceBin `json:"bins"`      // BinSeconds slices over t
	ErrTsMs []float64 `json:"err_ts_ms"` // press times of incorrect selections
	IkiHist []int     `json:"iki_hist"`  // IkiHistBuckets counts, 100 ms each
}

// ComputeMetrics walks the same replay state machine as scoring and
// aggregates diagnostics. keys must already be boundary-filtered; tSec is
// the same elapsed time the score used.
func ComputeMetrics(seq string, keys []Selection, tSec float64) *Metrics {
	m := &Metrics{
		Bins:    make([]PaceBin, max(1, int(math.Ceil(tSec/BinSeconds)))),
		IkiHist: make([]int, IkiHistBuckets),
	}
	if len(keys) == 0 || tSec <= 0 {
		return m
	}

	// Replay (same semantics as Replay in scoring.go).
	pos := 0
	sc, si := 0, 0
	errs := make([]bool, 0, len(keys))
	var ikis []float64
	for i, k := range keys {
		var correct bool
		if k.Key == BackspaceKey {
			m.Backspaces++
			if pos > 0 {
				correct = errs[pos-1]
				if correct {
					m.Corrected++
				} else {
					m.BackspaceBad++
				}
				pos--
				errs = errs[:pos]
			} else {
				m.BackspaceBad++
			}
		} else {
			m.Letters++
			if pos < len(seq) {
				correct = len(k.Key) == 1 && k.Key[0] == seq[pos]
				if !correct {
					m.LetterErrors++
				}
				errs = append(errs, !correct)
				pos++
			}
		}

		if correct {
			sc++
		} else {
			si++
			m.ErrTsMs = append(m.ErrTsMs, k.TPressedMs)
		}
		bin := int(k.TPressedMs / 1000 / BinSeconds)
		if bin >= len(m.Bins) { // a key exactly on the t boundary
			bin = len(m.Bins) - 1
		}
		if bin >= 0 {
			if correct {
				m.Bins[bin].Sc++
			} else {
				m.Bins[bin].Si++
			}
		}
		if i > 0 {
			iki := k.TPressedMs - keys[i-1].TPressedMs
			ikis = append(ikis, iki)
			if iki > StallThresholdMs {
				m.StallCount++
				m.StallMs += iki
			}
			bucket := int(iki / 100)
			if bucket >= IkiHistBuckets {
				bucket = IkiHistBuckets - 1
			}
			if bucket >= 0 {
				m.IkiHist[bucket]++
			}
		}
	}

	m.Selections = len(keys)
	m.Uncorrected = m.LetterErrors - m.Corrected
	m.GrossPerS = float64(m.Selections) / tSec
	m.NetPerS = float64(sc-si) / tSec
	m.AccuracyPct = 100 * float64(sc) / float64(m.Selections)
	m.DeadTailMs = tSec*1000 - keys[len(keys)-1].TPressedMs
	if m.DeadTailMs < 0 {
		m.DeadTailMs = 0
	}

	if len(ikis) > 0 {
		sorted := append([]float64(nil), ikis...)
		sort.Float64s(sorted)
		m.MinIkiMs = sorted[0]
		m.MaxIkiMs = sorted[len(sorted)-1]
		m.MedianIkiMs = quantile(sorted, 0.5)
		m.P90IkiMs = quantile(sorted, 0.9)
		sum := 0.0
		for _, x := range ikis {
			sum += x
		}
		m.MeanIkiMs = sum / float64(len(ikis))
	}
	return m
}

// quantile over a sorted slice, linear interpolation.
func quantile(sorted []float64, q float64) float64 {
	if len(sorted) == 1 {
		return sorted[0]
	}
	f := q * float64(len(sorted)-1)
	i := int(f)
	if i >= len(sorted)-1 {
		return sorted[len(sorted)-1]
	}
	return sorted[i] + (f-float64(i))*(sorted[i+1]-sorted[i])
}
