package main

// Machine-enforced policy checks (spec §4.1, §7):
//   - go.mod declares zero dependencies (Tier A is stdlib-only)
//   - shipped frontend code references no external URL (offline operation)

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestGoModHasNoDependencies(t *testing.T) {
	b, err := os.ReadFile("../go.mod")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "require") {
		t.Fatal("go.mod declares dependencies — Tier A is stdlib-only (spec §4.1)")
	}
}

// grep -rE 'https?://' over shipped HTML/JS must return zero hits (spec §7).
func TestNoExternalURLsInEnvironments(t *testing.T) {
	re := regexp.MustCompile(`https?://`)
	root := "../environments"
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for i, line := range strings.Split(string(b), "\n") {
			if re.MatchString(line) {
				t.Errorf("%s:%d references an external URL: %s", path, i+1, strings.TrimSpace(line))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
