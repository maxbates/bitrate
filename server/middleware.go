package main

// Public-exposure hardening (spec §6). The lab binary is normally localhost-only;
// once it sits behind a public reverse proxy these blunt the two realistic
// abuse vectors — oversized submits filling the disk, and submit/GET hammering.
// Body caps apply always (harmless, correct); the per-IP limiter arms only when
// BITRATE_PUBLIC is set, so the grader/ship and local-dev paths are unchanged.

import (
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// maxAPIBodyBytes caps POST bodies on /api/*. A 60 s run logs ~1–2k selections
// at a few hundred bytes each (well under 1 MB); 4 MiB is generous headroom that
// still stops an attacker streaming gigabytes into json.Decode.
const maxAPIBodyBytes = 4 << 20

// publicHardening wraps the API surface with a body-size cap (always) and a
// per-IP rate limiter (only under BITRATE_PUBLIC — the deploy path).
func publicHardening(next http.Handler) http.Handler {
	var rl *rateLimiter
	if os.Getenv("BITRATE_PUBLIC") != "" {
		rl = newRateLimiter(120, time.Minute) // 120 req/min/IP on /api/*
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			if r.Method == http.MethodPost {
				r.Body = http.MaxBytesReader(w, r.Body, maxAPIBodyBytes)
			}
			if rl != nil && !rl.allow(clientIP(r)) {
				httpErr(w, http.StatusTooManyRequests, "rate limit — slow down")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// clientIP prefers the left-most X-Forwarded-For hop (set by our own Caddy
// reverse proxy on the public deploy) and falls back to the socket peer.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// rateLimiter is a fixed-window per-IP counter — enough to blunt disk-fill and
// submit-hammering on the public instance. Not a precise token bucket; the goal
// is a ceiling on abuse, not fair queueing.
type rateLimiter struct {
	mu      sync.Mutex
	limit   int
	window  time.Duration
	windows map[string]*ipWindow
}

type ipWindow struct {
	count int
	reset time.Time
}

func newRateLimiter(limit int, w time.Duration) *rateLimiter {
	return &rateLimiter{limit: limit, window: w, windows: map[string]*ipWindow{}}
}

func (rl *rateLimiter) allow(ip string) bool {
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()
	w := rl.windows[ip]
	if w == nil || now.After(w.reset) {
		if len(rl.windows) > 10000 { // opportunistic GC so the map can't grow unbounded
			for k, v := range rl.windows {
				if now.After(v.reset) {
					delete(rl.windows, k)
				}
			}
		}
		rl.windows[ip] = &ipWindow{count: 1, reset: now.Add(rl.window)}
		return true
	}
	if w.count >= rl.limit {
		return false
	}
	w.count++
	return true
}
