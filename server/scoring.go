package main

// Authoritative scoring (spec §1, §2.4).
//
// Formula (Shenoy et al. 2021):
//
//	B = log2(N - 1) * max(Sc - Si, 0) / t
//
// N counts the reserved backspace key (the brief's own example prices N=30
// at log2(29)), so ship config is 26 letters + backspace: N=27,
// log2(26) ≈ 4.70 bits/selection.
//
// Error policy is advance-always: every selection consumes the target at the
// cursor, correct or not. Backspace is a first-class selection, judged
// correct iff it deletes an uncorrected error immediately behind the cursor,
// incorrect otherwise (including at position 0). Chained backspaces walk
// back a trailing run of errors. Every action has a deterministic verdict
// (rule 2 — unambiguous ground truth).

import "math"

// BackspaceKey is the literal used in keystroke logs for the reserved
// correction selection (matches KeyboardEvent.key).
const BackspaceKey = "Backspace"

// Selection is one logged selection event, replayed server-side.
type Selection struct {
	Index      int      `json:"i"`            // monotonic selection index
	Key        string   `json:"key"`          // folded character or "Backspace"
	Expected   string   `json:"expected"`     // client's view; informational only
	Verdict    bool     `json:"verdict"`      // client's verdict; informational only
	TShownMs   float64  `json:"t_shown_ms"`   // target entered fixation position
	TPressedMs float64  `json:"t_pressed_ms"` // keydown, ms since first scored keypress
	TKeyupMs   *float64 `json:"t_keyup_ms"`   // best-effort; feeds §6 bot heuristics
}

// Replay walks a selection log against the served sequence and returns
// Sc, Si. It trusts only key identities and order — never client verdicts.
func Replay(seq string, keys []Selection) (sc, si int) {
	pos := 0
	// errs[i] records whether the (uncorrected) selection at position i was
	// an error; truncated on backspace so it always mirrors the cursor.
	errs := make([]bool, 0, len(keys))
	for _, k := range keys {
		if k.Key == BackspaceKey {
			if pos > 0 {
				if errs[pos-1] {
					sc++ // deleted an uncorrected error
				} else {
					si++ // deleted a correct character
				}
				pos--
				errs = errs[:pos]
			} else {
				si++ // nothing behind the cursor to delete
			}
			continue
		}
		if pos >= len(seq) {
			// Sequence exhausted (should not happen at SequenceLen; the
			// client ends the bout). Ignore rather than invent ground truth.
			continue
		}
		ok := len(k.Key) == 1 && k.Key[0] == seq[pos]
		if ok {
			sc++
		} else {
			si++
		}
		errs = append(errs, !ok)
		pos++
	}
	return sc, si
}

// BitRate computes bits/selection and bits/second for the formula above.
// t is elapsed seconds; t <= 0 yields 0 (HUD reads 0.0 before the first
// keypress — no divide-by-zero, spec §2.5).
func BitRate(n, sc, si int, t float64) (bitsPerSelection, bps float64) {
	if n < 3 {
		return 0, 0
	}
	bitsPerSelection = math.Log2(float64(n - 1))
	if t <= 0 {
		return bitsPerSelection, 0
	}
	net := float64(sc - si)
	if net < 0 {
		net = 0
	}
	return bitsPerSelection, bitsPerSelection * net / t
}
