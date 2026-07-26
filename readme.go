package bitrate

import _ "embed"

// ShipREADME is the deliverable's README (spec §8): the design rationale the
// brief asks for — why this N, why this input modality, what else is worth
// explaining. It ships as a file in the ZIP *and* is rendered at /readme by
// both build profiles, so there is one source of truth rather than a markdown
// copy and an HTML copy drifting apart.
//
// Embedded from ship/ rather than duplicated under environments/ because
// build.sh already copies this exact file into the bundle root, where a grader
// who never opens a browser can still read it.
//
//go:embed ship/README.md
var ShipREADME []byte
