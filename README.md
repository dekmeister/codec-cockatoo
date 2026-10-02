# Codec Cockatoo

Codec Cockatoo is a single-page, JavaScript-only demo of how speech codecs work
and what they do to audio, plus what happens when packets are lost or bits
arrive wrong. It is a sibling of
[Signal Stonefish](https://github.com/dekmeister/signal-stonefish) and is built
the same way.

Pick a voice clip (three voices to choose from), a music clip, a 1020 Hz test tone, or your own file, then
choose a codec and a channel:

- **listen**: play/pause/stop, with the sound updating live as you change settings
- **see the waveform**: a whole-clip overview plus a zoomed view with original, decoded and error traces. Lost frames are shaded
- **see inside the codec** (the "Codec detail" overlay in the zoom view):
  - the samples actually decoded at the codec rate
  - the quantiser levels for PCM and G.711
  - the decoder's prediction and step band for ADPCM
  - the frames, voicing and pitch pulses for the vocoder
- **see the spectrum** in three views:
  - **Average**: the whole clip, Welch-averaged
  - **Zoom window**: just the zoomed samples, with the vocoder's decoded LPC envelope overlaid
  - **Waterfall**: live, SDR-style, with frequency across and time scrolling down from the playhead. Original and decoded sit side by side, each with the current spectrum above, coloured −100…0 dBFS.
    - While playing, rows show what was heard, so a mid-play settings change leaves a before/after boundary.
    - Pausing redraws the whole history with the current settings.
- **read the measured** bit rate, frames lost, bit errors, SNR, segmental SNR and spectral distortion

## Codecs

All are written for this page in plain JS. They are teaching versions and have not been tested for bit-exact output.

| Codec | Setting | Notes |
|---|---|---|
| Linear PCM, 8 or 16 kHz | 2–16 bits | Mid-tread quantiser, two's complement |
| G.711 μ-law / A-law | fixed, 64 kbit/s | Segment/mantissa encoding after the Sun reference `g711.c` |
| G.726 ADPCM | 16 / 24 / 32 / 40 kbit/s | Adaptive quantiser and 2-pole/6-zero predictor after the Sun reference `g72x.c` |
| IMA ADPCM | fixed, 33.2 kbit/s | 4 bits per sample, plus a 24-bit state header per 20 ms frame |
| LPC-10-style vocoder | 2400 / 1200 / 600 bit/s | 54-bit frames (pitch 7, gain 5, reflection coefficients as LARs 41, sync 1) every 22.5 / 45 / 90 ms |

## Channel

- **Frame loss**: 0–50 %. Losses are either independent or bursty (Gilbert model, mean run of 3 frames). Lost frames are concealed with silence, with a repeat of the last frame, or with a repeat that fades by 6 dB per frame.
- **Bit errors**: a BER from 10⁻⁷ to 0.5, spread uniformly over the packed bitstream with no error protection.

Both use fixed random seeds, so the same settings always give the same damage.

Presets cover comparisons (linear vs μ-law, linear vs ADPCM at the same rate, wideband), the telephone network (G.711, DECT/G.726, IMA), vocoders (LPC-10 at 2400/1200/600 bit/s), VoIP packet loss and radio-link bit errors.

## Files

| Path | What |
|---|---|
| `index.html` | The whole app: HTML, CSS and JS inline, no dependencies |
| `audio/voice.wav`, `audio/voice-woman.wav`, `audio/voice-deep.wav`, `audio/music.wav` | Bundled clips (CC BY; see `audio/SOURCES.md`) |
| `audio/SOURCES.md` | Where each clip came from, its licence and attribution |

The page looks for `audio/voice.{wav,mp3,ogg,flac,m4a,opus}` and the same
extensions for `voice-woman`, `voice-deep` and `music`. Clips are mixed to mono, trimmed to 20 s and normalised to
−3 dBFS peak.

## Running

Browsers block `fetch()` from `file://`, so serve the folder over HTTP:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` directly still works with the test tone and your own files.

## How it works

1. **Resampling.** The audio context runs at 48 kHz. A symmetric windowed-sinc
   FIR (Blackman window, cutoff 0.425 × codec rate, so 3.4 kHz at 8 kHz) decimates
   to the codec rate by an exact 6:1 or 3:1. The same filter interpolates back
   up for playback. It is zero-phase, so the codec output lines up with the
   original sample for sample.
2. **Bitstream.** Each codec writes real bits, stored one bit per byte, in
   frames: 20 ms for the sample codecs and the vocoder's own frame otherwise.
   Bit errors flip bits in that stream. Frame loss then marks whole frames
   lost, and the decoder conceals them.
3. **Measurement** is at the codec rate, against the band-limited original:
   - **SNR** is over the whole clip.
   - **Segmental SNR** is the mean of the SNRs of 20 ms frames, each clamped to
     −10…35 dB. Frames more than 40 dB below the loudest are skipped.
   - **Spectral distortion** is the RMS dB difference of third-octave band
     energies (250 Hz up to the codec band), averaged over the same frames.
   - SNR and segmental SNR are not shown for the vocoder, because it
     synthesises a new waveform.

## Licence

Code: MIT (see `LICENSE`). Audio clips: CC BY, credited in `audio/SOURCES.md`
and in the page's "How do these work?" popup.
