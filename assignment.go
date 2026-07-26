//go:build !ship

package bitrate

import _ "embed"

// AssignmentPDF is the homework brief this harness was built against, served
// at /assignment.pdf by the lab binary (the public instance) so anyone reading
// the site can check the harness against the brief it came from.
//
// Lab-only, by build tag rather than by flag (spec §8): the ship deliverable
// has no business carrying the grader's own assignment back to them.
//
//go:embed swe-homework.pdf
var AssignmentPDF []byte
