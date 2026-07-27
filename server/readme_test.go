package main

import (
	"bitrate"
	"encoding/json"
	"strings"
	"testing"
)

// The reclassification rule that makes the leaderboard honest: drum pad's page
// is pixel lens's implementation with the input mode fixed to touch, and the two
// were one environment until 2026-07-25. A pixel-lens variant carrying
// input:"touch" is therefore a drum-pad variant, and the board has to say so.
func TestEffectiveEnv(t *testing.T) {
	v := func(env, input string) *Variant {
		cfg, _ := json.Marshal(map[string]any{"environment": env, "input": input})
		return &Variant{Environment: env, Config: cfg}
	}
	cases := []struct {
		name string
		in   *Variant
		want string
	}{
		{"pixel-lens played with touch is drum pad", v("pixel-lens", "touch"), "drum-pad"},
		{"pixel-lens played with a mouse stays put", v("pixel-lens", "mouse"), "pixel-lens"},
		{"drum-pad is already itself", v("drum-pad", "touch"), "drum-pad"},
		{"other environments are never rewritten", v("stream-typing", "keys"), "stream-typing"},
		{"a nil variant yields no environment", nil, ""},
	}
	for _, c := range cases {
		if got := effectiveEnv(c.in); got != c.want {
			t.Errorf("%s: effectiveEnv = %q, want %q", c.name, got, c.want)
		}
	}
	// An unparseable config must not reclassify — better the stored name than a
	// guess (and it must not panic).
	broken := &Variant{Environment: "pixel-lens", Config: []byte("{not json")}
	if got := effectiveEnv(broken); got != "pixel-lens" {
		t.Errorf("broken config: effectiveEnv = %q, want %q", got, "pixel-lens")
	}
	// A config with no input field at all: same rule.
	noInput := &Variant{Environment: "pixel-lens", Config: []byte(`{"environment":"pixel-lens"}`)}
	if got := effectiveEnv(noInput); got != "pixel-lens" {
		t.Errorf("no input field: effectiveEnv = %q, want %q", got, "pixel-lens")
	}
}

func TestRenderMarkdown(t *testing.T) {
	got := renderMarkdown(strings.Join([]string{
		"# Title",
		"",
		"A **bold** and *slanted* line with `code` and a [link](https://x.test).",
		"",
		"- first item",
		"  wrapped continuation",
		"- second item",
		"",
		"| a | b |",
		"|---|---|",
		"| 1 | 2 |",
		"",
		"```",
		"raw <not> escaped**",
		"```",
	}, "\n"))

	for _, want := range []string{
		"<h1>Title</h1>",
		"<strong>bold</strong>",
		"<em>slanted</em>",
		"<code>code</code>",
		`<a href="https://x.test">link</a>`,
		"<li>first item wrapped continuation</li>",
		"<li>second item</li>",
		"<th>a</th>",
		"<td>1</td>",
		"<pre><code>raw &lt;not&gt; escaped**</code></pre>",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("rendered output missing %q\n---\n%s", want, got)
		}
	}
	if strings.Contains(got, "\x00") {
		t.Error("inline-code placeholder leaked into the output")
	}
}

// Markup in the source must not become markup in the page.
func TestRenderMarkdownEscapesHTML(t *testing.T) {
	got := renderMarkdown("A <script>alert(1)</script> line.")
	if strings.Contains(got, "<script>") {
		t.Errorf("raw script tag survived rendering: %s", got)
	}
	if !strings.Contains(got, "&lt;script&gt;") {
		t.Errorf("script tag was not escaped: %s", got)
	}
}

// A javascript: target is rendered as text, never as an href.
func TestRenderMarkdownRejectsUnsafeLinks(t *testing.T) {
	got := renderMarkdown("[click](javascript:alert(1))")
	if strings.Contains(got, "href") {
		t.Errorf("unsafe link became an anchor: %s", got)
	}
	if !strings.Contains(got, "click") {
		t.Errorf("link text was dropped: %s", got)
	}
}

// The shipped README has to actually render — this is the page the brief asks
// for, in both build profiles.
func TestShipReadmeRenders(t *testing.T) {
	html := renderMarkdown(readmeSource(t))
	for _, want := range []string{"<h1>", "<h2>", "<table>", "bits"} {
		if !strings.Contains(html, want) {
			t.Errorf("rendered README missing %q", want)
		}
	}
	if strings.Contains(html, "\x00") {
		t.Error("inline-code placeholder leaked into the rendered README")
	}
}

func readmeSource(t *testing.T) string {
	t.Helper()
	if len(bitrate.README) == 0 {
		t.Fatal("README.md embedded empty")
	}
	return string(bitrate.README)
}
