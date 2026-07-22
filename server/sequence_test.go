package main

import (
	"bytes"
	"strings"
	"testing"
)

const lowercase = "abcdefghijklmnopqrstuvwxyz"

// Frozen golden vectors — computed once from the pinned derivation
// (SHA-256(seed ‖ be64(k) ‖ be64(ctr)), rejection-sampled). Never update
// these to make a test pass; a mismatch means stored seeds no longer replay.
const (
	goldenZeroLower  = "xyqbomravxyrvmnswxqqwoyidcnkacekqsoalbqemerxncxnmllgewctqdkroqjm"
	goldenAsciiLower = "atqbgsnwpexchffbxlvuymrjkwrgaznchxpvcnftgtywhslbyabtmobeqdxvrdoq"
	goldenZeroAlnum  = "xqqx4ezwrz0jhid08t2sm0aoj2dw2706seq0x3s40ed3doxzcr16qc596patecp7"
)

// Golden vectors (spec §4.3): the derivation is pinned so replay survives
// toolchain upgrades. If this test breaks, the sequence function changed —
// that invalidates every stored seed. Do not update the vectors; fix the
// regression.
func TestGoldenVectors(t *testing.T) {
	seedA := bytes.Repeat([]byte{0x00}, 32)
	seedB := []byte("0123456789abcdef0123456789abcdef")

	cases := []struct {
		name     string
		seed     []byte
		alphabet string
		want     string // first 64 symbols
	}{
		{"zero seed / lowercase", seedA, lowercase, goldenZeroLower},
		{"ascii seed / lowercase", seedB, lowercase, goldenAsciiLower},
		{"zero seed / digits+letters", seedA, lowercase + "0123456789", goldenZeroAlnum},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := GenSequence(c.seed, c.alphabet, 64)
			if got != c.want {
				t.Fatalf("derivation changed!\n got  %q\n want %q", got, c.want)
			}
		})
	}
}

func TestSequenceDeterministic(t *testing.T) {
	seed, err := NewSeed()
	if err != nil {
		t.Fatal(err)
	}
	a := GenSequence(seed, lowercase, 500)
	b := GenSequence(seed, lowercase, 500)
	if a != b {
		t.Fatal("same seed produced different sequences")
	}
	// A prefix must be stable regardless of requested length (per-index
	// derivation, no running state).
	if !strings.HasPrefix(a, GenSequence(seed, lowercase, 100)) {
		t.Fatal("sequence prefix not stable across lengths")
	}
}

func TestSequenceAlphabetClosed(t *testing.T) {
	seed, _ := NewSeed()
	s := GenSequence(seed, lowercase, SequenceLen)
	if len(s) != SequenceLen {
		t.Fatalf("len = %d", len(s))
	}
	for i := 0; i < len(s); i++ {
		if !strings.ContainsRune(lowercase, rune(s[i])) {
			t.Fatalf("symbol %q outside alphabet at %d", s[i], i)
		}
	}
}

// Loose uniformity smoke test — catches modulo bias and gross derivation
// bugs, not a substitute for the pinned-derivation vectors above.
func TestSequenceUniformity(t *testing.T) {
	seed, _ := NewSeed()
	const n = 260000 // expect 10000 per symbol
	s := GenSequence(seed, lowercase, n)
	counts := map[byte]int{}
	for i := 0; i < len(s); i++ {
		counts[s[i]]++
	}
	for ch, c := range counts {
		// ±5% of expectation is ~±5 sigma; a biased sampler blows through it.
		if c < 9500 || c > 10500 {
			t.Errorf("symbol %q count %d, expected ~10000", ch, c)
		}
	}
	if len(counts) != 26 {
		t.Errorf("only %d symbols appeared", len(counts))
	}
	// Repeats must occur (i.i.d. with replacement — spec §7).
	repeats := 0
	for i := 1; i < len(s); i++ {
		if s[i] == s[i-1] {
			repeats++
		}
	}
	if repeats < n/26/2 {
		t.Errorf("suspiciously few repeats: %d", repeats)
	}
}
