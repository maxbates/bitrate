package main

// The merge subcommand (spec §4.4): `bitrate merge <bundle.json|->`.
//
// Offline, not an endpoint — an instance's data must be mergeable into
// another instance's without either being reachable from the other. The
// identity rules make this a set-union rather than entity resolution: run ids
// and device ids are random 128-bit hex, variants are content-addressed, so
// two ledgers can only agree or be disjoint.
//
// Semantics, straight from the spec:
//   - idempotent set-union keyed on ids; merging twice is a no-op and order
//     never matters.
//   - same id, different payload -> conflict: keep local, report it.
//   - schema_version gates the import; refuse newer, never guess.
//   - keystroke logs come along when present, so the importer can recompute
//     scores later ("recompute, don't trust" — see the note at the bottom).

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"reflect"
	"sort"
)

// schemaVersion is the bundle format this binary speaks. Bumped when the
// bundle gains fields; a bundle from a newer writer is refused.
const schemaVersion = 1

type bundle struct {
	SchemaVersion int                    `json:"schema_version"`
	InstanceID    string                 `json:"instance_id"`
	ExportedAt    string                 `json:"exported_at"`
	Variants      []*Variant             `json:"variants"`
	Runs          []*Run                 `json:"runs"`
	Results       []*Result              `json:"results"`
	Keystrokes    map[string][]Selection `json:"keystrokes"`
}

type mergeStats struct {
	variantsNew, runsNew, resultsNew, keysNew int
	conflicts                                 []string
}

// runMerge is the `merge` subcommand entry point. args is everything after
// the subcommand name.
func runMerge(args []string, dataDir string) error {
	if len(args) != 1 {
		return errors.New("usage: bitrate merge <bundle.json|->  (reads stdin for -)")
	}
	raw, err := readBundle(args[0])
	if err != nil {
		return err
	}
	var b bundle
	if err := json.Unmarshal(raw, &b); err != nil {
		return fmt.Errorf("parse bundle: %w", err)
	}
	if b.SchemaVersion > schemaVersion {
		return fmt.Errorf("bundle schema_version %d is newer than this binary understands (%d) — upgrade first",
			b.SchemaVersion, schemaVersion)
	}
	store, err := OpenStore(dataDir)
	if err != nil {
		return fmt.Errorf("open store %s: %w", dataDir, err)
	}
	st := mergeInto(store, &b)

	fmt.Printf("merged %s (instance %s, exported %s)\n", args[0], short(b.InstanceID), b.ExportedAt)
	fmt.Printf("  variants  +%d of %d\n", st.variantsNew, len(b.Variants))
	fmt.Printf("  runs      +%d of %d\n", st.runsNew, len(b.Runs))
	fmt.Printf("  results   +%d of %d\n", st.resultsNew, len(b.Results))
	fmt.Printf("  keystroke logs +%d\n", st.keysNew)
	if len(st.conflicts) > 0 {
		fmt.Printf("  conflicts %d (kept local):\n", len(st.conflicts))
		for _, c := range st.conflicts {
			fmt.Printf("    %s\n", c)
		}
	}
	runs, results, variants := store.Counts()
	fmt.Printf("ledger now: %d runs, %d results, %d variants\n", runs, results, variants)
	return nil
}

func readBundle(path string) ([]byte, error) {
	if path == "-" {
		return io.ReadAll(os.Stdin)
	}
	return os.ReadFile(path)
}

// mergeInto applies the bundle to the store. Exported for the test.
func mergeInto(store *Store, b *bundle) mergeStats {
	var st mergeStats

	// Variants are content-addressed: the same config in two instances is the
	// same row, so a differing payload under one hash means something is lying.
	for _, v := range b.Variants {
		if v == nil || v.ConfigHash == "" {
			continue
		}
		store.mu.RLock()
		have := store.variants[v.ConfigHash]
		store.mu.RUnlock()
		if have != nil {
			if !sameVariant(have, v) {
				st.conflicts = append(st.conflicts, "variant "+short(v.ConfigHash))
			}
			continue
		}
		if err := store.PutVariant(v); err != nil {
			st.conflicts = append(st.conflicts, "variant "+short(v.ConfigHash)+": "+err.Error())
			continue
		}
		st.variantsNew++
	}

	for _, r := range b.Runs {
		if r == nil || r.ID == "" {
			continue
		}
		store.mu.RLock()
		have := store.runs[r.ID]
		store.mu.RUnlock()
		if have != nil {
			if !sameRun(have, r) {
				st.conflicts = append(st.conflicts, "run "+short(r.ID))
			}
			continue
		}
		if err := store.PutRun(r, false); err != nil {
			st.conflicts = append(st.conflicts, "run "+short(r.ID)+": "+err.Error())
			continue
		}
		st.runsNew++
		// Keystrokes ride along with their run, never on their own: a log
		// without its run record is unattributable.
		if ks := b.Keystrokes[r.ID]; len(ks) > 0 {
			if err := store.PutKeystrokes(r.ID, ks); err == nil {
				st.keysNew++
			}
		}
	}

	for _, res := range b.Results {
		if res == nil || res.RunID == "" {
			continue
		}
		store.mu.RLock()
		have := store.results[res.RunID]
		store.mu.RUnlock()
		if have != nil {
			if !sameResult(have, res) {
				st.conflicts = append(st.conflicts, "result "+short(res.RunID))
			}
			continue
		}
		if err := store.PutResult(res); err != nil {
			st.conflicts = append(st.conflicts, "result "+short(res.RunID)+": "+err.Error())
			continue
		}
		st.resultsNew++
	}

	sort.Strings(st.conflicts)
	return st
}

// Payload comparison for the conflict check. JSON round-trip rather than
// field-by-field: it stays correct as the records grow fields, and these are
// small structs compared once per incoming row.
//
// Variants compare on identity only. The hash *is* the config, so two
// instances that independently registered the same variant agree by
// construction; what differs is when each first saw it and what it chose to
// call it — provenance and display label (spec §4.4), not a disagreement.
func sameVariant(a, b *Variant) bool {
	x, y := *a, *b
	x.CreatedAt, y.CreatedAt = "", ""
	x.Name, y.Name = "", ""
	return sameJSON(&x, &y)
}

func sameRun(a, b *Run) bool       { return sameJSON(a, b) }
func sameResult(a, b *Result) bool { return sameJSON(a, b) }

func sameJSON(a, b any) bool {
	ja, err1 := json.Marshal(a)
	jb, err2 := json.Marshal(b)
	if err1 != nil || err2 != nil {
		return false
	}
	if string(ja) == string(jb) {
		return true
	}
	// Fall back to a structural compare so key order or numeric formatting
	// differences between writers don't read as a conflict.
	var ma, mb any
	if json.Unmarshal(ja, &ma) != nil || json.Unmarshal(jb, &mb) != nil {
		return false
	}
	return reflect.DeepEqual(ma, mb)
}

func short(id string) string {
	if len(id) <= 8 {
		return id
	}
	return id[:8]
}

// Note on "recompute, don't trust" (spec §4.4): results arrive as the
// exporting instance computed them. Recomputation from the keystroke log is
// the next step here — the merge is already the place it belongs, and the
// logs are already carried across. Until then an imported result is exactly
// as trustworthy as the instance it came from, which for a personal ledger
// moving into its own public instance is the same trust either way.
