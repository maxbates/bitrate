# bitrate games

A set of games for maximizing the bit rate through an HCI. Source: <https://github.com/maxbates/bitrate>.

To play the primary game Drum Pad, **open <https://bitrate.einkgen.link> on a touch-input device, ideally a larger tablet, or use your phone.**

- **Setup & Tips**: pick a tile size at your preference, then iterate quickly during practice:
  - Try a couple sizes (use settings gear in header) for your fingers and dexterity that give you speed but prioritize accuracy >= ~ 95+
  - Try one or two pointer fingers to minimize travel, extended pointer fingers reduces screen coverage
  - Pay attention to the green look-ahead dot. 
- **To play**: tap `arm scored run` or hit `Enter`. Tap the yellow squares.

**Other things on the site:** the [gallery](https://bitrate.einkgen.link/env/>) has the some of the other environments we built, using other input mechanisms, and a graveyard of the ones we gave up on. The leaderboard ranks the contenders.

## Scoring overview

Games are scored as:

```
B = log2(N − 1) · max(Sc − Si, 0) / t     bits per second
```

Where N = alphabet size, Sc = correct interactions, Si = incorrect interactions.

In Drum Pad, N = the number of tiles (determined by viewport and tile size), and taps are correct or not (judged at landing, there is no backspace in this game). Squares are selected at I.I.D. 

Using the default Drum Pad configuration, **players scored around 10 - 15 bps during testing**.

## Motivations

Code and therefore experimenting in software is cheap. 

So from the beginning, I planned to: 
- research HCIs, perception, motor input, etc.
- think through several input mechanisms
- build a handful of configurable games to try
- test them myself and then with a small panel of play-testers
- collect stats in a leaderboard
- and pick the best performer(s)

Familiar mechanism: Because only 1 minute of practice/habituation is allowed, many possible mechanisms were discounted (e.g. stenography, piano, video game controllers for some) in favor of familiar ones (keyboard, touch). 

Avoid overlearning: Randomness rapidly degrades speed of overlearned input patterns, e.g. typing random strings vs words. My own random-string typing was about 1/4 the speed of prose. Touch needs no practice, and uses a device the user is familiar with (probably their own).

Provenance: Originally started as pixel lens game on computer, which tried to maximize alphabet using a grid. Added touch variant, which removed taxes of pointing (cursor indirection, a loupe for detail) and split out to its own game.

Stimulus and travel: Despite the fingers being fixed on a keyboard and traveling on a touch device, direct touch doesnt require as much processing and translation to motor movement - the stimulus is the response. Taps require travel, but still won on speed and provide more bits per interaction (depending on grid size)

Grid size: Grid size trades off bits with speed (finger/arm travel) and accuracy (misses are double-penalized). Experimenting with grid size found that smaller squares (12mm) worked best on a phone and larger squares (20mm) best on a tablet, with caveats around practice impacting measurements. By Fitt's law, travel time of 2 arms/fingers dominates on a tablet and larger stops are preferable, and a phone with less travel benefits from extra bits of a denser grid. Cells shrink as 1/sqrt(N), so difficulty grows as ~1/2•log2(N) while bits grow as ~log2(N)

### Design, improvements, affordances

- Defaults: player testing informs default recommended grid size, etc., but configurable depending on user's preferences, finger size, desire to prioritize speed / accuracy
- Size preferences are encoded in mm, rather than pixels, to translate better across devices
- Color: black background, yellow target square stands out from background
- Look-ahead dot: green bullseye ensures finger already moving to next target
- Animation: ensure no wasted saccades. Small animation for look-ahead to get peripheral attention
- Sound: Feedback on mis-taps e.g. just outside the target if already looking at next target. Needs to support several per second, should not be intrusive.
- Feedback: flash a banner if hit the wrong target, to begin a practice run... these could probably be better designed :) 

## Motivations: technical

This repo is almost entirely vibe coded to enable fast game iteration: with some manual QA / play testing I was confident we could get to a good working game without needing to look under the hood.

Originally I planned to upload a self-contained not-too-big pre-built binary. I used Go so we could easily target multiple platforms. 

Once it became clear touch was a leading contender input device, it made more sense to just host it. It also made testing with my parents easier :) 

I happened to have a cheap URL already purchased in S3 for an e-ink display project, so I just reused that. So, this game is hosted on a subdomain `bitrate` of `einkgen.link`. There is a fallback to host a static website and drive the games solely through the front-end, in case the server falls down for whatever reason.

The bundle is a single static Go binary — **standard library only, no cgo, no dependencies** serving an embedded vanilla-JS frontend. No framework, build step, bundler, CDN, or package manager. Charts are hand-rolled SVG, tones are WebAudio, and markdown is rendered by a small markdown subset in the server itself. The run.sh script starts a loopback-only server, prints a URL, and opens your browser; it works fully offline. 

The self-contained bundle exists so the repo could be distributed on its own, but a local server on a laptop cannot give you a touchscreen, and ultimately it's easier to connect your touch device (and get HTTPS needed for some games, e.g. for webcam or mic access on iOS) using a hosted site. 

### Running it yourself

From a clone:

```
bash run.sh
```

To play from a phone or tablet on the same WiFi, use `bash run.sh -addr :4700` and open one of the LAN URLs it prints.


## Ideas & graveyard


Built and measured:

- drum pad (tap the lit tile) → the winner, ~16 bps. 6.4 bits per tap and the stimulus is the response — nothing to translate, no repertoire to acquire, so it survives first contact
- stream typing (keyboard, 26 letters) → 20–40 bps was a prose number; typing's speed lives in overlearned digram/word motor programs, and i.i.d. deletes all of them → 2.6 keystrokes/s, 10.34 bps, a sixth of the 200-wpm implied rate
- beat hands (paced highway; webcam swipes / keys / touch) → an external tempo is a hard ceiling, you can't beat the beat; deep lookahead didn't recover it → 7.81
- pixel lens (mouse + fisheye loupe) → Fitts-bound serial pointer; cursor indirection plus a loupe that invites stop-and-verify; alphabet size can't rescue a serial pointing device → 7.27
- parabola fall (thumb slides along an arc) → sliding pays for distance linearly, so jumps had to be bounded, which starves the alphabet to log2(2M) ≈ 2.6 bits/step → 5.20
- lane tap (1D lane strip, ballistic taps) → a 1D strip throws away a dimension without shortening the movement; Fitts time is distance/width, so tap cost was unchanged while bits/tap fell ~35% — same motor cost, half the information → ~8 vs a predicted 15–17
- twin stick (two thumbs, 8 octants each) → bimanual coordination has in-phase/anti-phase attractors; arbitrary independent L/R targets fight them — "it's definitely not parallel processing"
- voice babble (on-device DSP, per-player templates) → recognition overhead dominates the event: VAD onset + classify window + breath reset, several hundred ms wrapped around ~150 ms of signal
- word typing → banned by rule 1 by name; also a wash (~18 vs ~19 bps), since a word costs its letters
- speech words → ASR endpointing is 300–800 ms and irreducible without the language model the brief forbids

Modeled but not built:

- multi-touch chords (2–3 tiles at once) → bits add, alphabets multiply — two taps double the bits, not square them; unordered simultaneity forfeits log2(k!); accuracy goes as p^k under a double penalty; and two dots on a big grid is two saccades — the motor act parallelizes, visual acquisition doesn't
- dragging or crossing → deflates to a technique the current UI already permits; hard to not have UI be responsive to targets, i.e. both obvious commit rules fail (count every cell-entry → error storm; arm only lit cells → sweep hack)
- combine with voice (onset × vowel, 30 symbols) → never built; different modalities could pay off, but slows each interaction
- glyph-trace / handwriting → tracing earns bits linearly in time; tapping earns log2(N) per ballistic act — shape is produced sequentially, position is chosen all at once → ~6–12 bps ceiling
- webcam gaze → dies on the sensor, not the human: 2–4° error caps N at 9–16 → 2–5 bps

What ifs:

- phone as GPS, run in a direction → bits grow as log of area, time grows as sqrt area; 3 m GPS noise forces 12 m cells, didn't quantify accelerometer; only 4–5 selections fit in 60 s so the score quantizes into a lottery
- stenography → raises bits per motor event, but needs years of training and exploits the language redundancy the brief forbids
- piano → same shape: a real repertoire acquired over years, and no hardware to hand
- chord-pad (keyboard key-chords) → discards twenty years of single-key motor training for an elegant alphabet
- foot pedal / held modifier → to stay i.i.d. the modifier state must also be random, so if it flips every target you've bought a second decision, not a free bit
- voice + hand poses → never built; every added binary channel must clear a reliability bar or it costs net bps
- asymmetric thumb-modifier chord (aimed cell × 4 fixed thumb zones) → not built; adds bits/act, no saccade, no Fitts on the modifier
- thumb-keys (stationary phone thumb stations) → never built; trading N for zero travel
- dual-modality (speak digits while typing letters) → best candidate on paper for a truly additive channel; expected to fail on refractory-period costs plus ASR latency
- multi-feature symbol codes (colour × shape → hand × finger) → inserts a learned translation table between stimulus and response, paying translation latency on every trial
- gesture-keyboard path decoding (Swype) → genuinely predictive; needs a language model to decode the word
- own hardware / mailed MIDI controller → hardware you can't ship is a demo they can't grade, and it adds a failure mode to a one-shot eval
- 8-direction swipe → N capped at 8 (2.81 bits), diagonal confusion 5–15%; cadence can't make it up → 5–6 bps
- raw on-screen QWERTY → ~6–7 bps once the random-string penalty is applied; never built

Alphabet / config variants:

- casing (N=53) → +21% bits, but uniform sampling forces ~50% capitals and we can't tune the rate without breaking i.i.d.; same-hand shifts are slow → ~−24% rate
- letters + digits (N=37) → genuinely too close to call: +10% bits, needs ~91% speed retention. Never resolved — the one real open question
- home row only (N=9) → must sustain 1.48× the cadence to break even
- multi-character doublets → bits/sec is invariant to bracketing, and compounds make scoring all-or-nothing, which is poison under double-penalized errors
- word-level targets → banned by name; economics were a wash anyway, which is why the ban cost nothing

