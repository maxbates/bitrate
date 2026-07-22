package main

// Variant identity (spec §4.4): a variant is content-addressed by the
// SHA-256 of its canonical config JSON (sorted keys, no whitespace; the
// environment key is a field of the config). Two instances that
// independently define the same config merge into one variant automatically.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
)

// Config is the parsed, validated subset of a variant config that the
// server needs. The full document is preserved verbatim-canonicalized for
// hashing and storage.
type Config struct {
	Environment string
	Alphabet    string
	Backspace   bool
	DurationS   float64
	Canonical   []byte // canonical JSON (sorted keys, no whitespace)
	Hash        string // hex SHA-256 of Canonical
}

// N returns the number of possible selections including the reserved
// backspace key when enabled (spec §1: N >= 3 required).
func (c *Config) N() int {
	n := len(c.Alphabet)
	if c.Backspace {
		n++
	}
	return n
}

// ParseConfig canonicalizes and validates a raw config document.
func ParseConfig(raw map[string]any) (*Config, error) {
	env, _ := raw["environment"].(string)
	if env == "" {
		return nil, errors.New("config.environment required")
	}
	alphabet, _ := raw["alphabet"].(string)
	if len(alphabet) < 2 {
		return nil, errors.New("config.alphabet must have >= 2 symbols")
	}
	seen := map[byte]bool{}
	for i := 0; i < len(alphabet); i++ {
		ch := alphabet[i]
		if ch < 0x21 || ch > 0x7e {
			return nil, fmt.Errorf("config.alphabet: non-printable-ASCII symbol %q", ch)
		}
		if seen[ch] {
			return nil, fmt.Errorf("config.alphabet: duplicate symbol %q", ch)
		}
		seen[ch] = true
	}
	backspace, _ := raw["backspace"].(bool)
	duration, _ := raw["duration_s"].(float64)
	if duration <= 0 {
		return nil, errors.New("config.duration_s must be > 0")
	}
	cfg := &Config{
		Environment: env,
		Alphabet:    alphabet,
		Backspace:   backspace,
		DurationS:   duration,
	}
	if cfg.N() < 3 {
		return nil, errors.New("N must be >= 3")
	}
	// encoding/json marshals maps with sorted keys and no whitespace —
	// exactly the canonical form (spec §4.3).
	canonical, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	cfg.Canonical = canonical
	sum := sha256.Sum256(canonical)
	cfg.Hash = hex.EncodeToString(sum[:])
	return cfg, nil
}
