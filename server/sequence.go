package main

// Seeded i.i.d. sequence generation (spec §4.3).
//
// The derivation is pinned, not delegated to a library default, so replay
// survives toolchain upgrades and identical sequences can be served for
// paired comparison:
//
//	seed      = 32 bytes from crypto/rand
//	symbol k  = first accepted byte of SHA-256(seed ‖ be64(k) ‖ be64(ctr)),
//	            ctr = 0,1,2,... — a byte b is accepted iff b < 256 - 256%m
//	            (rejection sampling: no modulo bias), symbol = alphabet[b%m]
//
// Golden test vectors live in sequence_test.go.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"strings"
)

// SequenceLen is sized far beyond any human maximum: 60 s at a fantasy
// 30 cps is 1,800 selections. The client never extends the sequence and
// nothing touches the network mid-run (spec §4.3).
const SequenceLen = 2000

// NewSeed returns 32 bytes from crypto/rand.
func NewSeed() ([]byte, error) {
	seed := make([]byte, 32)
	if _, err := rand.Read(seed); err != nil {
		return nil, err
	}
	return seed, nil
}

// GenSequence derives n i.i.d. uniform symbols from seed over alphabet.
// Uniform with replacement — repeats are required, not a bug (spec §7).
func GenSequence(seed []byte, alphabet string, n int) string {
	m := len(alphabet)
	limit := 256 - 256%m // rejection threshold: bytes >= limit are re-drawn

	var b strings.Builder
	b.Grow(n)
	buf := make([]byte, 0, len(seed)+16)
	for k := 0; k < n; k++ {
		for ctr := uint64(0); ; ctr++ {
			buf = buf[:0]
			buf = append(buf, seed...)
			buf = binary.BigEndian.AppendUint64(buf, uint64(k))
			buf = binary.BigEndian.AppendUint64(buf, ctr)
			h := sha256.Sum256(buf)
			done := false
			for _, x := range h {
				if int(x) < limit {
					b.WriteByte(alphabet[int(x)%m])
					done = true
					break
				}
			}
			if done {
				break
			}
			// All 32 digest bytes rejected (probability (256%m / 256)^32 —
			// astronomically rare for any real alphabet): bump ctr, redraw.
		}
	}
	return b.String()
}
