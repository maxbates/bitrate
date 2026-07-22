// Package bitrate holds the embedded frontend assets.
//
// This file lives at the repo root because go:embed cannot reference a parent
// directory: the server binary (server/) must embed environments/, so the
// embed directive has to sit above both. The module is stdlib-only (Tier A,
// spec §4.1); deps_test.go asserts go.mod stays dependency-free.
package bitrate

import "embed"

// EnvFS embeds every environment frontend. Assets are served from here in
// normal operation; the -dev flag serves from disk instead (spec §4.2).
//
//go:embed all:environments
var EnvFS embed.FS
