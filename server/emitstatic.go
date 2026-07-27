package main

// -emit-static writes the frontend out as a plain directory tree: the static
// backup site (spec §8.1), uploaded to S3 and served when the primary instance
// fails its health check.
//
// The binary emits it rather than a shell script assembling it, for one reason:
// the binary already carries the embedded environments *and* the markdown
// renderer, so what it writes cannot drift from what it serves. A `cp -r` of the
// source tree would miss the rendered README and the root redirect, and would
// silently diverge the day either changes.
//
// What the static site can and cannot do is a property of the frontend, not of
// this file: a scored run works (the sequence is drawn locally by
// BitrateOffline, and the score was always computed client-side), while the
// leaderboard, run history, and server-side recomputation are simply absent —
// their fetches fail and the pages already degrade.

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"bitrate"
)

func emitStatic(env fs.FS, outDir string) error {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return err
	}

	// environments/ -> <out>/env/, the same path the server serves them at, so
	// every in-page link (/env/drum-pad/, ../pixel-lens/game.css) resolves
	// unchanged. Getting this wrong is the whole failure mode of a static
	// mirror, so the layout is copied rather than reinvented.
	n := 0
	err := fs.WalkDir(env, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		dst := filepath.Join(outDir, "env", filepath.FromSlash(p))
		if d.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		src, err := env.Open(p)
		if err != nil {
			return err
		}
		defer src.Close()
		out, err := os.Create(dst)
		if err != nil {
			return err
		}
		defer out.Close()
		if _, err := io.Copy(out, src); err != nil {
			return err
		}
		n++
		return nil
	})
	if err != nil {
		return err
	}

	// The README, rendered by the same code path /readme uses. Written to
	// readme/index.html so the link target `/readme` resolves on a static host
	// without rewrite rules, and the raw markdown alongside it.
	if err := os.MkdirAll(filepath.Join(outDir, "readme"), 0o755); err != nil {
		return err
	}
	page := readmeHead + renderMarkdown(string(bitrate.README)) + readmeFoot
	if err := os.WriteFile(filepath.Join(outDir, "readme", "index.html"), []byte(page), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(outDir, "readme.md"), bitrate.README, 0o644); err != nil {
		return err
	}

	// / -> the game. The server does this with a 302; a static host needs a real
	// document, so this is a meta refresh plus a link for anything that ignores
	// it. The banner is deliberate: a player who lands here has arrived because
	// the primary is down, and should know the run won't be recorded before they
	// spend 60 seconds on it.
	root := strings.ReplaceAll(staticIndexHTML, "{{GAME}}", shipGame)
	if err := os.WriteFile(filepath.Join(outDir, "index.html"), []byte(root), 0o644); err != nil {
		return err
	}

	fmt.Printf("==> static site -> %s (%d asset files + readme + root)\n", outDir, n)
	return nil
}

const staticIndexHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bit-rate</title>
<meta http-equiv="refresh" content="0; url=/env/{{GAME}}/">
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center;
         justify-content:center; background:#101216; color:#d7dae0;
         font:14px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  a { color:#7aa2f7; }
</style>
</head>
<body>
  <p>Loading the game — <a href="/env/{{GAME}}/">continue</a>.</p>
</body>
</html>
`
