package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Storage is append-only JSONL, last-wins by id on reload (spec §4.4).
func TestStoreReload(t *testing.T) {
	dir := t.TempDir()
	s1, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	run := &Run{ID: "aa11", VariantID: "v1", DeviceID: "d1", StartedAt: nowRFC3339(), IsScored: true}
	if err := s1.PutRun(run, false); err != nil {
		t.Fatal(err)
	}
	// Second append with EndedAt set — the completed record.
	run2 := *run
	run2.EndedAt = nowRFC3339()
	if err := s1.PutRun(&run2, true); err != nil {
		t.Fatal(err)
	}
	if err := s1.PutResult(&Result{RunID: "aa11", N: 27, Sc: 10, Si: 1, Bps: 0.7}); err != nil {
		t.Fatal(err)
	}
	if err := s1.PutKeystrokes("aa11", []Selection{{Index: 0, Key: "a"}}); err != nil {
		t.Fatal(err)
	}

	// Fresh store over the same directory: last-wins reload.
	s2, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	got := s2.GetRun("aa11")
	if got == nil || got.EndedAt == "" {
		t.Fatal("reload did not keep the completed (last) run record")
	}
	if s2.results["aa11"] == nil || s2.results["aa11"].Sc != 10 {
		t.Fatal("result not reloaded")
	}
	if s2.instanceID != s1.instanceID {
		t.Fatal("instance id not stable across restarts")
	}
	if b, err := os.ReadFile(filepath.Join(dir, "keys", "aa11.jsonl")); err != nil || len(b) == 0 {
		t.Fatalf("keystroke log unreadable: %v", err)
	}
}

func TestVariantIdempotent(t *testing.T) {
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	v := &Variant{ConfigHash: "h1", Name: "x", CreatedAt: nowRFC3339()}
	if err := s.PutVariant(v); err != nil {
		t.Fatal(err)
	}
	if err := s.PutVariant(v); err != nil {
		t.Fatal(err)
	}
	// Reload: exactly one registration.
	s2, err := OpenStore(s.dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(s2.variants) != 1 {
		t.Fatalf("%d variants after duplicate put", len(s2.variants))
	}
}

func TestRandHex128(t *testing.T) {
	a, err := randHex128()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := randHex128()
	if len(a) != 32 || a == b {
		t.Fatalf("bad ids: %q %q", a, b)
	}
}
