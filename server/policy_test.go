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

// The shipped frontend must fetch nothing from the network (spec §7): no CDN
// script, stylesheet, font, or image, and no fetch/XHR to another host. This is
// the static backstop; the ship gate proves it at runtime by asserting zero
// non-localhost requests during a full scored run.
//
// What is allowed, narrowly: an external URL as the href of an `<a>` element.
// A hyperlink issues no request until a human clicks it and then navigates
// away, so it cannot break offline operation — and the submission now links out
// to the source repo from the gallery footer (spec §8). Everything else that
// could name a host is still rejected, so `<img src>`, `<link href>`, `url()`
// in CSS, `import`, and `fetch()` all still fail this test.
func TestNoExternalURLsInEnvironments(t *testing.T) {
	external := regexp.MustCompile(`https?://`)
	anchorTag := regexp.MustCompile(`(?i)<a\s[^>]*>`)
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
			if !external.MatchString(line) {
				continue
			}
			// Drop anchor open-tags, then re-test: anything still naming a host
			// is a subresource or a request, not a hyperlink.
			if external.MatchString(anchorTag.ReplaceAllString(line, "")) {
				t.Errorf("%s:%d references an external URL: %s", path, i+1, strings.TrimSpace(line))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// The narrowing above must not have opened a hole: a CDN script tag, a remote
// stylesheet, or a cross-host fetch still has to fail, and a plain hyperlink
// still has to pass.
func TestNoExternalURLsRuleStillCatchesSubresources(t *testing.T) {
	external := regexp.MustCompile(`https?://`)
	anchorTag := regexp.MustCompile(`(?i)<a\s[^>]*>`)
	rejects := func(line string) bool {
		return external.MatchString(line) &&
			external.MatchString(anchorTag.ReplaceAllString(line, ""))
	}
	for _, bad := range []string{
		`<script src="https://cdn.example.com/x.js"></script>`,
		`<link rel="stylesheet" href="https://fonts.example.com/f.css">`,
		`<img src="http://example.com/a.png">`,
		`  const r = await fetch('https://api.example.com/v1');`,
		`@import url("https://example.com/s.css");`,
		`  background: url(https://example.com/bg.png);`,
		// An anchor is not a licence for a subresource on the same line.
		`<a href="https://ok.example">ok</a><img src="https://bad.example/x.png">`,
	} {
		if !rejects(bad) {
			t.Errorf("policy check no longer rejects a network reference: %s", bad)
		}
	}
	for _, ok := range []string{
		`<a href="https://github.com/maxbates/bitrate" target="_blank" rel="noopener">source</a>`,
		`<a href="/readme">design notes</a>`,
		`const path = '/env/drum-pad/';`,
	} {
		if rejects(ok) {
			t.Errorf("policy check wrongly rejects a hyperlink: %s", ok)
		}
	}
}
