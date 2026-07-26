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
	"path/filepath"
	"runtime"
	"time"

	"bitrate"
)

func hexEncode(b []byte) string { return hex.EncodeToString(b) }

func isFlagArg(a string) bool { return len(a) > 1 && a[0] == '-' }

func main() {
	var (
		addr      = flag.String("addr", "127.0.0.1:0", "listen address (loopback, OS-assigned port — spec §8)")
		dataDir   = flag.String("data", "data", "data directory (JSONL)")
		dev       = flag.Bool("dev", false, "serve frontend assets from disk (environments/) instead of the embedded copies")
		devRoot   = flag.String("dev-root", "environments", "asset root for -dev")
		noBrowser = flag.Bool("no-browser", false, "do not try to open the browser")
	)
	// `bitrate merge <bundle>` is a subcommand, not a flag mode (spec §4.4:
	// merge is offline and never an endpoint). Parse flags after it so
	// `-data` still selects the ledger to merge into.
	isMerge := len(os.Args) > 1 && os.Args[1] == "merge"
	var mergeArgs []string
	if isMerge {
		rest := os.Args[2:]
		for len(rest) > 0 && !isFlagArg(rest[0]) {
			mergeArgs = append(mergeArgs, rest[0])
			rest = rest[1:]
		}
		os.Args = append([]string{os.Args[0]}, rest...)
	}
	flag.Parse()

	if isMerge {
		if *dataDir == "data" && buildProfile == "lab" {
			if home, err := os.UserHomeDir(); err == nil {
				*dataDir = filepath.Join(home, ".bitrate", "data")
			}
		}
		if err := runMerge(mergeArgs, *dataDir); err != nil {
			log.Fatalf("merge: %v", err)
		}
		return
	}

	// Lab persists to one stable, home-anchored ledger regardless of where the
	// server is launched from (so runs never scatter into per-cwd data/ dirs).
	// Ship/gate keep the isolated relative dir — grading and tests must never
	// touch the personal ledger.
	if *dataDir == "data" && buildProfile == "lab" {
		if home, err := os.UserHomeDir(); err == nil {
			*dataDir = filepath.Join(home, ".bitrate", "data")
		}
	}

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
	if buildProfile == "lab" {
		absData, _ := filepath.Abs(*dataDir)
		nRuns, nResults, nVariants := store.Counts()
		fmt.Printf("\n  ledger: %s\n  (%d runs · %d results · %d variants — this file only grows)\n", absData, nRuns, nResults, nVariants)
	}
	fmt.Printf("\n  (paste the URL into a browser if one doesn't open)\n\n")
	// BITRATE_NO_BROWSER lets test harnesses that exec run.sh (which passes no
	// flags) suppress the courtesy browser-open without editing the grader path.
	if !*noBrowser && os.Getenv("BITRATE_NO_BROWSER") == "" {
		go openBrowser(url)
	}

	// Timeouts, because the deployed site is now the whole deliverable and a
	// wedged connection is indistinguishable from an outage to a grader. Bare
	// http.Serve applies none of these: a client that opens a socket and never
	// finishes its request headers holds a goroutine and its buffers forever, so
	// enough of them exhaust the box without anything crashing — which is worse
	// than crashing, since systemd's Restart=always can't fix what hasn't died.
	//
	// Read side is tight (that's the abuse vector). Write side is deliberately
	// slack: the game's responses are tiny, but /api/export with keystroke logs
	// is multi-megabyte and pulling it over a slow link must not get cut off.
	httpSrv := &http.Server{
		Handler:           publicHardening(srv.routes()),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	log.Fatal(httpSrv.Serve(ln))
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
