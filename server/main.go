// Command server is the bit-rate harness: static serving, seeded sequences,
// authoritative scoring, JSONL storage. Go stdlib only (Tier A, spec §4.1).
package main

import (
	"encoding/hex"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"

	"bitrate"
)

func hexEncode(b []byte) string { return hex.EncodeToString(b) }

func main() {
	var (
		addr      = flag.String("addr", "127.0.0.1:0", "listen address (loopback, OS-assigned port — spec §8)")
		dataDir   = flag.String("data", "data", "data directory (JSONL)")
		dev       = flag.Bool("dev", false, "serve frontend assets from disk (environments/) instead of the embedded copies")
		devRoot   = flag.String("dev-root", "environments", "asset root for -dev")
		noBrowser = flag.Bool("no-browser", false, "do not try to open the browser")
	)
	flag.Parse()

	var env fs.FS
	if *dev {
		env = os.DirFS(*devRoot)
	} else {
		sub, err := fs.Sub(bitrate.EnvFS, "environments")
		if err != nil {
			log.Fatal(err)
		}
		env = sub
	}

	store, err := OpenStore(*dataDir)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	srv := newServer(store, env)
	srv.dev = *dev

	// Loopback explicitly (binding all interfaces invites firewall prompts),
	// OS-assigned port (never a hardcoded one that might be occupied).
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	url := fmt.Sprintf("http://%s/", ln.Addr())

	// Print the URL prominently first, then try the browser. Browser-launch
	// is best-effort, never load-bearing (spec §8).
	fmt.Printf("\n  bit-rate harness\n\n  ▶  %s\n\n  (paste the URL into a browser if one doesn't open)\n\n", url)
	if !*noBrowser {
		go openBrowser(url)
	}

	log.Fatal(http.Serve(ln, srv.routes()))
}

// openBrowser is best-effort: xdg-open on Linux (the supported platform),
// open on the macOS courtesy path. Failure is fine — the URL is printed.
func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("browser open failed (harmless — use the printed URL): %v", err)
	}
}
