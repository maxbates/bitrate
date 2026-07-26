package main

// Merge is a set-union or it is nothing (spec §4.4): these lock in the three
// properties the rest of the design leans on — new rows land, re-merging
// changes nothing, and a same-id-different-payload row never overwrites local.

import (
	"encoding/json"
	"os"
	"testing"
)

func testBundle() *bundle {
	return &bundle{
		SchemaVersion: schemaVersion,
		InstanceID:    "aaaabbbbccccdddd",
		ExportedAt:    "2026-07-25T00:00:00Z",
		Variants: []*Variant{{
			ConfigHash:  "hash-1",
			Name:        "drum-pad",
			Config:      json.RawMessage(`{"environment":"drum-pad","alphabet_size":64,"duration_s":60}`),
			Environment: "drum-pad",
			CreatedAt:   "2026-07-25T00:00:00Z",
		}},
		Runs: []*Run{{
			ID:        "run-1",
			VariantID: "hash-1",
			DeviceID:  "dev-1",
			StartedAt: "2026-07-25T00:00:01Z",
			DurationS: 60,
			IsScored:  true,
		}},
		Results: []*Result{{
			RunID: "run-1", N: 64, Sc: 100, Si: 3, Bps: 9.5,
		}},
		Keystrokes: map[string][]Selection{
			"run-1": {{Key: "7", Expected: "7", Verdict: true, TPressedMs: 120}},
		},
	}
}

func mergeStore(t *testing.T) *Store {
	t.Helper()
	s, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	return s
}

func TestMergeAddsRows(t *testing.T) {
	s := mergeStore(t)
	st := mergeInto(s, testBundle())
	if st.variantsNew != 1 || st.runsNew != 1 || st.resultsNew != 1 || st.keysNew != 1 {
		t.Fatalf("expected one of each, got %+v", st)
	}
	if len(st.conflicts) != 0 {
		t.Fatalf("unexpected conflicts: %v", st.conflicts)
	}
	runs, results, variants := s.Counts()
	if runs != 1 || results != 1 || variants != 1 {
		t.Fatalf("counts = %d/%d/%d, want 1/1/1", runs, results, variants)
	}
	ks, err := s.ReadKeystrokes("run-1")
	if err != nil || len(ks) != 1 || ks[0].Key != "7" {
		t.Fatalf("keystroke log not carried: %v %v", ks, err)
	}
}

// Merging the same bundle twice must change nothing — the property that lets
// the pull cadence run whenever, with overlapping `since` windows.
func TestMergeIsIdempotent(t *testing.T) {
	s := mergeStore(t)
	mergeInto(s, testBundle())
	st := mergeInto(s, testBundle())
	if st.variantsNew+st.runsNew+st.resultsNew+st.keysNew != 0 {
		t.Fatalf("second merge was not a no-op: %+v", st)
	}
	if len(st.conflicts) != 0 {
		t.Fatalf("re-merging identical rows reported conflicts: %v", st.conflicts)
	}
	runs, results, variants := s.Counts()
	if runs != 1 || results != 1 || variants != 1 {
		t.Fatalf("counts drifted to %d/%d/%d", runs, results, variants)
	}
}

func TestMergeKeepsLocalOnConflict(t *testing.T) {
	s := mergeStore(t)
	mergeInto(s, testBundle())

	b := testBundle()
	b.Results[0].Bps = 999 // same run id, different payload: someone is lying
	st := mergeInto(s, b)

	if len(st.conflicts) != 1 {
		t.Fatalf("expected one conflict, got %v", st.conflicts)
	}
	s.mu.RLock()
	got := s.results["run-1"].Bps
	s.mu.RUnlock()
	if got != 9.5 {
		t.Fatalf("local result was overwritten: bps = %v, want 9.5", got)
	}
}

func TestMergeRefusesNewerSchema(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/bundle.json"
	b := testBundle()
	b.SchemaVersion = schemaVersion + 1
	raw, _ := json.Marshal(b)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := runMerge([]string{path}, dir); err == nil {
		t.Fatal("expected a refusal for a newer schema_version")
	}
}

// The same content-addressed variant registered on two instances differs only
// in when each first saw it — provenance, not a disagreement.
func TestMergeVariantProvenanceIsNotAConflict(t *testing.T) {
	s := mergeStore(t)
	mergeInto(s, testBundle())

	b := testBundle()
	b.Variants[0].CreatedAt = "2026-07-26T09:00:00Z"
	b.Variants[0].Name = "drum pad"
	st := mergeInto(s, b)

	if len(st.conflicts) != 0 {
		t.Fatalf("created_at/name should not conflict: %v", st.conflicts)
	}
}

// But a differing config under the same hash means something is lying.
func TestMergeVariantConfigConflicts(t *testing.T) {
	s := mergeStore(t)
	mergeInto(s, testBundle())

	b := testBundle()
	b.Variants[0].Config = json.RawMessage(`{"environment":"drum-pad","alphabet_size":9999,"duration_s":60}`)
	st := mergeInto(s, b)

	if len(st.conflicts) != 1 {
		t.Fatalf("expected a config conflict, got %v", st.conflicts)
	}
}
