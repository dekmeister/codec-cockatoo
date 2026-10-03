# CLAUDE.md: Codec Cockatoo

An educational single page showing how speech codecs work and what they do to real
audio (voice, music, a 1020 Hz tone or a user file). It covers linear PCM, G.711, G.726 and
IMA ADPCM, and an LPC-10-style vocoder, with frame loss and bit errors on the channel.
It has live playback, waveform and FFT plots, and presets. It is a sibling of
`../signal-stonefish` and shares its structure and much of its code. The remote is
`git@github.com:dekmeister/codec-cockatoo.git`.
- `tools/deploy.sh` uploads the page to NearlyFreeSpeech. It is git-ignored because it holds the login.

## Layout
- No libraries, no build step, no modules: plain files loaded by `<script>` tags in order.
  - `index.html` is the markup and the help popup.
  - `style.css` is all the CSS.
  - `dsp.js` is the signal processing. It has no DOM access and no shared state, and must load first.
    In order:
    - helpers
    - filters and the integer-ratio resampler (`firFor`, `decimate`, `interpolate`)
    - the bitstream (`BitWriter`, `BitReader`)
    - the codecs: G.711, `G726`, IMA, `LPC`
    - the `CODECS` registry
    - channel (`flipBits`, `lossPattern`) and `measure`
    - the FFT and `welch`
  - `app.js` is everything else:
    - state and source loading
    - `processAudio`
    - playback and plots
    - UI wiring, and `PRESETS` at the end
- Adding a file means listing it in `index.html` **and** in `tools/deploy.sh` (git-ignored), which uploads an explicit file list.
- Sample codecs implement `encodeSample`/`readSample` (plus optional `encodeHeader`/`readHeader`).
  The generic `encodeSamples`/`decodeSamples` frame them. The vocoder brings its own `encode`/`decode`.
- `audio/` holds the CC BY clips, copied from signal-stonefish. `audio/SOURCES.md` has their attribution,
  and the page's "How do these work?" popup credits them too. Keep those credits if the clips change.

## Design rules (from the user, same as signal-stonefish)
- Simple and plain. Light mode only. Avoid the "AI-generated" look (no card grids, pills or tinted tiles).
- Everything fits on one iPad-landscape screen (about 1024×690) without scrolling.
  Explanations go in the popup, not on the page.
- Keep page text minimal. Preset notes are kept to about two lines so the sidebar fits.
- **No hidden processing.** Anything that changes the sound or the numbers must be visible
  or explained in the UI. Every slider sets a physical parameter (bits, bit rate, loss %, BER), and
  every figure is a measurement. There are no target-seeking searches.
- Sliders: moving right means a lower bit rate, more loss or more errors.
- Values can be typed into the number boxes as well as set with the sliders.
- The codecs are teaching versions. Don't claim bit-exactness in the UI.

## Testing
- Serve the folder with `python3 -m http.server <port>`. `file://` blocks loading the clips.
- Headless check: `chromium --headless=new --no-sandbox --virtual-time-budget=15000 --screenshot=… --window-size=1024,690`.
  - Screenshots render at the full window size. Scripts run before that, in a viewport about 87 px shorter,
    so for layout measurements from an injected script (e.g. the sidebar's `scrollHeight`) use `--window-size=1024,777`.
  - `decodeAudioData` hangs in headless Chromium, so test on a copy without `audio/` (copy
    `index.html`, `style.css`, `dsp.js`, `app.js`); the page then falls back to the tone.
  - Script tests by injecting a `<script>` into that copy (with Python, not sed, so `\n`
    in strings survives). Set `S.x`, set controls, call `processAudio()` and read `S.res`.
    Print the results into a `<pre>` and read them with `--dump-dom`.
  - Reference figures:
    - 16-bit PCM at 8 kHz on the tone: about 92 dB SNR.
    - G.711 on the −6 dBFS tone: about 36.5 dB (μ-law) and 38.7 dB (A-law).
    - G.726 on AR(2) noise: about 9 / 14 / 20 / 25 dB at 16 / 24 / 32 / 40 kbit/s.
- Run the server as its own background command. Stop it with a bracketed pattern,
  e.g. `pkill -f "m http.serve[r] 8000"`, and never in the same command line that started it,
  or pkill matches its own shell and kills it.
