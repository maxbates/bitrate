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
	fmt.Printf("\n  bit-rate harness\n\n  ▶  %s\n", url)
	// When bound to a wildcard address (e.g. -addr :4700), also print the LAN
	// URLs so a phone or tablet on the same WiFi can reach it — pixel-lens
	// touch mode is the motivating case. No camera/mic there, so plain HTTP is
	// fine; getUserMedia modes would need a secure context and are localhost-only.
	if host, port, splitErr := net.SplitHostPort(*addr); splitErr == nil && (host == "" || host == "0.0.0.0" || host == "::") {
		for _, ip := range lanIPs() {
			fmt.Printf("  ▶  http://%s:%s/  (same-WiFi devices — e.g. iPad, touch mode)\n", ip, port)
		}
	}
	fmt.Printf("\n  (paste the URL into a browser if one doesn't open)\n\n")
	// BITRATE_NO_BROWSER lets test harnesses that exec run.sh (which passes no
	// flags) suppress the courtesy browser-open without editing the grader path.
	if !*noBrowser && os.Getenv("BITRATE_NO_BROWSER") == "" {
		go openBrowser(url)
	}

	log.Fatal(http.Serve(ln, srv.routes()))
}

// lanIPs returns this host's private IPv4 addresses (non-loopback), best-effort,
// so the startup banner can print same-WiFi URLs. Failure yields an empty list.
func lanIPs() []string {
	var out []string
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return out
	}
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip := ipn.IP.To4()
		if ip == nil || ip.IsLoopback() || !ip.IsPrivate() {
			continue
		}
		out = append(out, ip.String())
	}
	return out
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
