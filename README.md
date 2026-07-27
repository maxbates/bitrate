# drum pad

A game for maximizing the bit rate a human can push through a computer
interface, scored as

```
B = log2(N − 1) · max(Sc − Si, 0) / t     bits per second
```

One tile on a grid lights up. You tap it. That's the whole game.

## Play it

**Open <https://bitrate.einkgen.link> on a tablet or phone.** That's the whole
setup. Nothing to install, no bundle to unpack.

You want a **touchscreen** — drum pad is a direct-touch game, and played with a
mouse it becomes a different and worse game (which is why the mouse-driven
variant is a separate entry in the gallery rather than a setting here).

**Other things on the site:** the [gallery](/env/) has the seven other
environments we built and a graveyard of the ones that lost, each with the
reason it lost. The leaderboard ranks the contenders.

### Running it yourself

The source is at <https://github.com/maxbates/bitrate>. From a clone:

```
bash run.sh
```

Requires Go and nothing else — no dependencies, no bundler, no package manager.
The script starts a loopback-only server, prints a URL, and opens your browser;
it works fully offline. To play from a phone or tablet on the same WiFi, use
`bash run.sh -addr :4700` and open one of the LAN URLs it prints.

This path exists so the repo stands on its own, but it is not the intended one:
a local server on a laptop cannot give you a touchscreen, and pairing a tablet
to it over your network is exactly the setup the hosted URL avoids.

## How to play

- **Pick a tile size** on first open. The badged size is what has scored best
  on a screen the size of yours. Take the recommendation or ignore it — see
  *why this size*, below.
- **Practice is free and unlimited.** The tile lights up, you tap it, the next
  one lights up. A dimmer **look-ahead dot** shows where the next target will
  be, so your other finger can already be moving.
- **Arm the scored run** with the `arm scored run` button (or `Enter`). Your
  **first tap starts the 60-second clock** — the board is already on screen, so
  take as long as you like before that first tap.
- After 60.000 s input freezes and the results card shows your bit rate with
  N, Sc, Si, and a breakdown of where the bits went.
- **Two fingers on a tablet**, one on a phone — on a phone, one finger keeps
  your hand from covering the board.

## The accounting, stated up front

- **Targets are i.i.d. uniform** over the tiles, drawn server-side from a
  seeded generator, sampled **with replacement** — the same tile can light up
  twice in a row. No patterns, no structure, no language model, no predictive
  anything.
- **N is the number of tiles**, recomputed from your viewport. Tiles are the
  distinguishable selections: any touch inside a tile selects that tile, so
  counting tiles — rather than pixels or touch coordinates — is the honest
  alphabet size. Resizing the window mid-run changes the alphabet and therefore
  invalidates the run.
- **Every tap is a selection and is judged at the moment it lands.** Right tile
  or wrong, the tap consumes the current target and the next one appears.
  There is no stall state and no ambiguity about what the correct action was.
- **There is no correction key.** A tap is committed the instant it lands;
  there is nothing behind the cursor to delete. The scoring formula charges
  `log2(N − 1)` for a reserved correction key whether or not one exists, so we
  pay for it here — at N = 84 that is 0.017 bits per tap, which is the cheapest
  honest option available. (A correction tile would cost a whole tile out of
  the grid and a decision out of every error.)
- **The live bit-rate readout** updates once per second over all elapsed
  session time. The final score is recomputed server-side from the tap log, and
  any disagreement with the client's number is recorded as an anomaly.
- **The visible look-ahead dot does not break i.i.d.** The upcoming draws are
  already fixed; showing one adds no exploitable structure. It exists because
  human perceptual bandwidth vastly exceeds motor output, and the only useful
  thing to spend the surplus on is planning the next movement.

## Why touch, and not the keyboard

We expected the keyboard to win. It didn't, and the reason is the most
interesting thing we found.

A keyboard offers ~4.7 bits per keystroke (26 letters + a backspace) and
practiced typists reach 200 wpm, which looks like ~40 bits/s. But 200 wpm is a
*prose* number. It exists because English is redundant and typists have
overlearned motor programs for digrams and whole words. **An i.i.d. letter
sequence has none of that**, and the brief explicitly forbids putting it back.
Stripped of language structure, our best typing run managed 2.6 keystrokes/s —
about 10 bits/s, roughly a sixth of the prose-implied rate.

Direct touch has no such dependency. A tile grid gives **6.4 bits per tap** —
more per selection than a letter — and the stimulus *is* the response: the
thing that lights up is the thing you touch, with no learned mapping between
them and nothing to translate. That is why it survives first contact, which is
the only session that gets scored here.

Measured, best scored 60-second run per game, human players only:

| game | modality | best bits/s |
|---|---|---|
| **drum pad** | touch | **16.26** |
| stream typing | keyboard, 26 letters | 10.34 |
| beat hands | keyboard, paced | 7.81 |
| pixel lens | mouse + fisheye loupe | 7.27 |
| parabola fall | keyboard, paced | 5.20 |

For calibration: the best invasive brain–computer interface in the literature
this scoring formula comes from reports ~8.6 bits/s.

## Why this N, and why this tile size

N is not a free parameter — the tile size sets it, and the tile size is a
property of your hand and your screen. Bigger tiles mean fewer of them: fewer
bits per tap, but more taps per second and fewer misses, and **a miss is
double-penalized** (it forfeits a +1 *and* subtracts 1). So the tile size is
whatever maximizes the product, and that is an empirical question.

At the recommended sizes: **N = 84** on a tablet (a 14×6 grid at 20 mm) for
6.38 bits/tap, **N = 77** on a phone (7×11 at 12 mm) for 6.25 bits/tap.

The measured optimum is not where ergonomics predicted, and the two device
classes disagree — best scored run per tile size:

| | 12 mm | 16 mm | 20 mm |
|---|---|---|---|
| **tablet** | 14.98 | 12.93 | **16.26** |
| **phone** | **15.41** | — | 11.36 |

The tablet wants *bigger* tiles than the phone. Fitts's law explains it: on a
tablet you play with two index fingers and a freely moving arm, so travel time
dominates and fewer, larger stops win. On a phone one thumb barely travels, so
travel is nearly free and the extra bits per tap from a denser grid are pure
profit. Pushing the tablet to 12 mm buys 8.1 bits/tap and *loses* overall —
misses and travel eat more than the extra bits pay.

Note what this rules out. A far larger grid is available and scores worse; the
ceiling here is the finger, not the alphabet.

## Things worth knowing

- **The settings gear is real and you should use it.** Tile size, look-ahead
  depth, and the error sound are all live during practice. Every change mints
  a new content-addressed variant, so any configuration you land on is exactly
  reproducible. The defaults are what won, not what we guessed.
- **A miss buzzes and flashes red.** Deliberately loud — under double-penalized
  scoring an unnoticed miss is worth two, and the fastest way to lose is to
  keep sprinting past errors.
- **No third-party anything.** The page loads no CDN script, stylesheet, font,
  or image — every asset comes from the same server that served the page, which
  a test enforces. Run it from a clone and it works with the network off.

## How it's built

A single static Go binary — **standard library only, no cgo, no dependencies**
(CI asserts `go.mod` stays empty) — serving an embedded vanilla-JS frontend. No
framework, no build step, no bundler, no CDN, no package manager. Charts are
hand-rolled SVG, tones are WebAudio, and this page is rendered by a small
markdown subset in the server itself.

Targets are drawn server-side from a seeded generator, so any run is replayable
from its seed, and the score is recomputed from the tap log rather than trusted
from the client.

Source: <https://github.com/maxbates/bitrate>.
