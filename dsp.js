"use strict";
// Codec Cockatoo: the signal processing. Pure number-crunching on Float32Arrays, no DOM and no shared state.
// Filters and resampler, bitstream, the codecs (G.711, G.726, IMA ADPCM, LPC vocoder), the channel,
// measurement and the FFT. Loaded before app.js.

// ---------- small helpers ----------
const dB = r => 10 * Math.log10(r);
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
function power(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return s / a.length; }
function peakOf(a) { let p = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > p) p = v; } return p; }
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}


// ---------- filters ----------
// RBJ biquad (used for the vocoder's pitch-detector low-pass)
function biquad(x, type, f0, sr) {
  const w = 2 * Math.PI * f0 / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2);
  let b0, b1, b2;
  if (type === "lp") { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; }
  else { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
  const a0 = 1 + al, a1 = -2 * cs, a2 = 1 - al;
  b0 /= a0; b1 /= a0; b2 /= a0; const A1 = a1 / a0, A2 = a2 / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - A1 * y1 - A2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
// Resampling by an integer ratio R. One symmetric windowed-sinc FIR (Blackman, 24 codec-rate samples
// each side) is both the anti-alias filter and the anti-image filter. It cuts at 0.425 × the codec rate
// (3.4 kHz for 8 kHz) and is centred, so it adds no delay.
const FIRS = {};
function firFor(R) {
  if (FIRS[R]) return FIRS[R];
  const c = 24 * R, fc = 0.425 / R, h = new Float64Array(2 * c + 1);
  let s = 0;
  for (let j = -c; j <= c; j++) {
    const sinc = j === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * j) / (Math.PI * j);
    const w = 0.42 + 0.5 * Math.cos(Math.PI * j / c) + 0.08 * Math.cos(2 * Math.PI * j / c);
    h[j + c] = sinc * w; s += h[j + c];
  }
  for (let j = 0; j < h.length; j++) h[j] /= s;
  return (FIRS[R] = h);
}
function decimate(x, R) {
  const h = firFor(R), c = (h.length - 1) / 2, m = Math.ceil(x.length / R), y = new Float32Array(m);
  for (let k = 0; k < m; k++) {
    const n0 = k * R - c, j1 = Math.min(h.length, x.length - n0);
    let s = 0;
    for (let j = Math.max(0, -n0); j < j1; j++) s += h[j] * x[n0 + j];
    y[k] = s;
  }
  return y;
}
function interpolate(y, R, n) {
  const h = firFor(R), c = (h.length - 1) / 2, out = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const m0 = Math.max(0, Math.ceil((t - c) / R)), m1 = Math.min(y.length - 1, Math.floor((t + c) / R));
    let s = 0;
    for (let m = m0; m <= m1; m++) s += y[m] * h[c + t - m * R];
    out[t] = s * R;
  }
  return out;
}

// ---------- bitstream ----------
// One byte per bit keeps flipping and reading simple. Fields are written MSB first.
class BitWriter {
  constructor(n) { this.b = new Uint8Array(n); this.p = 0; }
  put(v, n) { for (let i = n - 1; i >= 0; i--) this.b[this.p++] = (v >> i) & 1; }
}
class BitReader {
  constructor(b, p = 0) { this.b = b; this.p = p; }
  get(n) { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | this.b[this.p++]; return v; }
  getSigned(n) { const v = this.get(n); return v >= 1 << (n - 1) ? v - (1 << n) : v; }
}
const toPcm16 = v => clamp(Math.round(v * 32768), -32768, 32767);

// ---------- G.711 (after the Sun Microsystems reference g711.c) ----------
const SEG_UEND = [0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF, 0x1FFF];
const SEG_AEND = [0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF];
function segOf(v, table) { let i = 0; while (i < 8 && v > table[i]) i++; return i; }
function linear2ulaw(pcm) {
  let v = pcm >> 2, mask = 0xFF;
  if (v < 0) { v = -v; mask = 0x7F; }
  v = Math.min(v, 8159) + 0x21;
  const seg = segOf(v, SEG_UEND);
  if (seg >= 8) return 0x7F ^ mask;
  return ((seg << 4) | ((v >> (seg + 1)) & 0xF)) ^ mask;
}
function ulaw2linear(u) {
  u = ~u & 0xFF;
  const t = (((u & 0x0F) << 3) + 0x84) << ((u & 0x70) >> 4);
  return u & 0x80 ? 0x84 - t : t - 0x84;
}
function linear2alaw(pcm) {
  let v = pcm >> 3, mask = 0xD5;
  if (v < 0) { mask = 0x55; v = -v - 1; }
  const seg = segOf(v, SEG_AEND);
  if (seg >= 8) return 0x7F ^ mask;
  return ((seg << 4) | ((seg < 2 ? v >> 1 : v >> seg) & 0xF)) ^ mask;
}
function alaw2linear(a) {
  a ^= 0x55;
  let t = (a & 0x0F) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8; else if (seg === 1) t += 0x108; else { t += 0x108; t <<= seg - 1; }
  return a & 0x80 ? t : -t;
}

// ---------- G.726 ADPCM (after the Sun Microsystems reference g72x.c) ----------
const G726 = (() => {
  const POW2 = [1, 2, 4, 8, 0x10, 0x20, 0x40, 0x80, 0x100, 0x200, 0x400, 0x800, 0x1000, 0x2000, 0x4000];
  // per rate: quantiser decision levels, log reconstruction levels, scale-factor and speed-control weights.
  // "zero": the 24/32/40k quantisers have a zero level (code 2^bits−1); 16k has none.
  const RATES = {
    16: { bits: 2, zero: false, qtab: [261], dqln: [116, 365, 365, 116],
          wi: [-704, 14048, 14048, -704], fi: [0, 0xE00, 0xE00, 0] },
    24: { bits: 3, zero: true, qtab: [8, 218, 331], dqln: [-2048, 135, 273, 373, 373, 273, 135, -2048],
          wi: [-128, 960, 4384, 18624, 18624, 4384, 960, -128], fi: [0, 0x200, 0x400, 0xE00, 0xE00, 0x400, 0x200, 0] },
    32: { bits: 4, zero: true, qtab: [-124, 80, 178, 246, 300, 349, 400],
          dqln: [-2048, 4, 135, 213, 273, 323, 373, 425, 425, 373, 323, 273, 213, 135, 4, -2048],
          wi: [-12, 18, 41, 64, 112, 198, 355, 1122, 1122, 355, 198, 112, 64, 41, 18, -12].map(v => v << 5),
          fi: [0, 0, 0, 0x200, 0x200, 0x200, 0x600, 0xE00, 0xE00, 0x600, 0x200, 0x200, 0x200, 0, 0, 0] },
    40: { bits: 5, zero: true, qtab: [-122, -16, 68, 139, 198, 250, 298, 339, 378, 413, 445, 475, 502, 528, 553],
          dqln: [-2048, -66, 28, 104, 169, 224, 274, 318, 358, 395, 429, 459, 488, 514, 539, 566,
                 566, 539, 514, 488, 459, 429, 395, 358, 318, 274, 224, 169, 104, 28, -66, -2048],
          wi: [448, 448, 768, 1248, 1280, 1312, 1856, 3200, 4512, 5728, 7008, 8960, 11456, 14080, 16928, 22272,
               22272, 16928, 14080, 11456, 8960, 7008, 5728, 4512, 3200, 1856, 1312, 1280, 1248, 768, 448, 448],
          fi: [0, 0, 0, 0, 0, 0x200, 0x200, 0x200, 0x200, 0x200, 0x400, 0x600, 0x800, 0xA00, 0xC00, 0xC00,
               0xC00, 0xC00, 0xA00, 0x800, 0x600, 0x400, 0x200, 0x200, 0x200, 0x200, 0x200, 0, 0, 0, 0, 0] },
  };
  const quan = (v, t, size) => { let i = 0; while (i < size && v >= t[i]) i++; return i; };
  // multiply a predictor coefficient by a value held as 4-bit exponent + 6-bit mantissa
  function fmult(an, srn) {
    const anmag = an > 0 ? an : (-an) & 0x1FFF, anexp = quan(anmag, POW2, 15) - 6;
    const anmant = anmag === 0 ? 32 : anexp >= 0 ? anmag >> anexp : anmag << -anexp;
    const wanexp = anexp + ((srn >> 6) & 0xF) - 13, wanmant = (anmant * (srn & 0x3F) + 0x30) >> 4;
    const r = wanexp >= 0 ? (wanmant << wanexp) & 0x7FFF : wanmant >> -wanexp;
    return (an ^ srn) < 0 ? -r : r;
  }
  // a value as 4-bit exponent + 6-bit mantissa, sign as in the 16-bit original (0xFC20 → −992)
  function toFloat(v) {
    if (v === 0) return 0x20;
    const mag = Math.abs(v), exp = quan(mag, POW2, 15), f = (exp << 6) + ((mag << 6) >> exp);
    return v > 0 ? f : f - 0x400;
  }
  function newState() {
    return { yl: 34816, yu: 544, dms: 0, dml: 0, ap: 0, a: [0, 0], b: [0, 0, 0, 0, 0, 0],
             pk: [0, 0], dq: [32, 32, 32, 32, 32, 32], sr: [32, 32], td: 0 };
  }
  function stepSize(s) {
    if (s.ap >= 256) return s.yu;
    let y = s.yl >> 6;
    const dif = s.yu - y, al = s.ap >> 2;
    if (dif > 0) y += (dif * al) >> 6; else if (dif < 0) y += (dif * al + 0x3F) >> 6;
    return y;
  }
  function quantize(d, y, T) {
    const dqm = Math.abs(d), exp = quan(dqm >> 1, POW2, 15), mant = ((dqm << 7) >> exp) & 0x7F;
    const dln = (exp << 7) + mant - (y >> 2), size = T.qtab.length, i = quan(dln, T.qtab, size);
    if (d < 0) return (size << 1) + 1 - i;
    if (i === 0 && T.zero) return (size << 1) + 1;
    return i;
  }
  function reconstruct(sign, dqln, y) {
    const dql = dqln + (y >> 2);
    if (dql < 0) return sign ? -0x8000 : 0;
    const dex = (dql >> 7) & 15, dqt = 128 + (dql & 127), dq = (dqt << 7) >> (14 - dex);
    return sign ? dq - 0x8000 : dq;
  }
  function update(s, bits, y, wi, fi, dq, sr, dqsez) {
    const pk0 = dqsez < 0 ? 1 : 0, mag = dq & 0x7FFF;
    // transition detector: a sudden large step after a steady tone resets the predictor
    const ylint = s.yl >> 15, ylfrac = (s.yl >> 10) & 0x1F, thr1 = (32 + ylfrac) << ylint;
    const thr2 = ylint > 9 ? 31 << 10 : thr1, dqthr = (thr2 + (thr2 >> 1)) >> 1;
    const tr = s.td !== 0 && mag > dqthr ? 1 : 0;
    // quantiser scale factor
    s.yu = clamp(y + ((wi - y) >> 5), 544, 5120);
    s.yl += s.yu + ((-s.yl) >> 6);
    // adaptive predictor coefficients
    let a2p = 0;
    if (tr) { s.a = [0, 0]; s.b = [0, 0, 0, 0, 0, 0]; }
    else {
      const pks1 = pk0 ^ s.pk[0];
      a2p = s.a[1] - (s.a[1] >> 7);
      if (dqsez !== 0) {
        const fa1 = pks1 ? s.a[0] : -s.a[0];
        if (fa1 < -8191) a2p -= 0x100; else if (fa1 > 8191) a2p += 0xFF; else a2p += fa1 >> 5;
        if (pk0 ^ s.pk[1]) { if (a2p <= -12160) a2p = -12288; else if (a2p >= 12416) a2p = 12288; else a2p -= 0x80; }
        else if (a2p <= -12416) a2p = -12288; else if (a2p >= 12160) a2p = 12288; else a2p += 0x80;
      }
      s.a[1] = a2p;
      s.a[0] -= s.a[0] >> 8;
      if (dqsez !== 0) s.a[0] += pks1 === 0 ? 192 : -192;
      const a1ul = 15360 - a2p;
      s.a[0] = clamp(s.a[0], -a1ul, a1ul);
      for (let i = 0; i < 6; i++) {
        s.b[i] -= bits === 5 ? s.b[i] >> 9 : s.b[i] >> 8;
        if (mag) s.b[i] += (dq ^ s.dq[i]) >= 0 ? 128 : -128;
      }
    }
    for (let i = 5; i > 0; i--) s.dq[i] = s.dq[i - 1];
    s.dq[0] = mag === 0 ? (dq >= 0 ? 0x20 : -992) : toFloat(dq >= 0 ? mag : -mag);
    s.sr[1] = s.sr[0];
    s.sr[0] = sr <= -32768 ? -992 : toFloat(sr);
    s.pk[1] = s.pk[0]; s.pk[0] = pk0;
    // tone detector and adaptation speed
    s.td = !tr && a2p < -11776 ? 1 : 0;
    s.dms += (fi - s.dms) >> 5;
    s.dml += ((fi << 2) - s.dml) >> 7;
    if (tr) s.ap = 256;
    else if (y < 1536 || s.td || Math.abs((s.dms << 2) - s.dml) >= (s.dml >> 3)) s.ap += (0x200 - s.ap) >> 4;
    else s.ap += (-s.ap) >> 4;
  }
  // one step, shared by encoder and decoder: code is given (decoder) or found from sl (encoder)
  function step(s, T, sl, code) {
    let sezi = 0;
    for (let i = 0; i < 6; i++) sezi += fmult(s.b[i] >> 2, s.dq[i]);
    const sez = sezi >> 1, se = (sezi + fmult(s.a[1] >> 2, s.sr[1]) + fmult(s.a[0] >> 2, s.sr[0])) >> 1;
    const y = stepSize(s);
    s.se = se; s.y = y; // kept for the codec-detail overlay
    const i = code ?? quantize(sl - se, y, T);
    const dq = reconstruct(i & (1 << (T.bits - 1)), T.dqln[i], y);
    const sr = dq < 0 ? se - (dq & 0x3FFF) : se + dq;
    update(s, T.bits, y, T.wi[i], T.fi[i], dq, sr, sr + sez - se);
    return { code: i, sr };
  }
  return {
    RATES, newState,
    encode: (s, T, pcm) => step(s, T, pcm >> 2).code,  // 14-bit input
    decode: (s, T, code) => step(s, T, 0, code).sr << 2,
  };
})();

// ---------- IMA ADPCM ----------
const IMA_STEPS = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97,
  107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484,
  7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];
function imaApply(s, code) { // decoder update, also run by the encoder so both stay in step
  const step = IMA_STEPS[s.index];
  let d = step >> 3;
  if (code & 4) d += step; if (code & 2) d += step >> 1; if (code & 1) d += step >> 2;
  s.pred = clamp(code & 8 ? s.pred - d : s.pred + d, -32768, 32767);
  s.index = clamp(s.index + IMA_INDEX[code & 7], 0, 88);
}
function imaEncode(s, pcm) {
  let diff = pcm - s.pred, code = 0, step = IMA_STEPS[s.index];
  if (diff < 0) { code = 8; diff = -diff; }
  if (diff >= step) { code |= 4; diff -= step; } step >>= 1;
  if (diff >= step) { code |= 2; diff -= step; } step >>= 1;
  if (diff >= step) code |= 1;
  imaApply(s, code);
  return code;
}

// ---------- LPC vocoder (a simplified LPC-10) ----------
const LPC = {
  order: 10, preEmph: 0.9375, win: 240,                 // 30 ms analysis window
  // bits per field; the frame is the same 54 bits at every rate, only sent less often
  FIELDS: [["pitch", 7], ["gain", 5], ["k1", 5], ["k2", 5], ["k3", 5], ["k4", 5], ["k5", 4], ["k6", 4], ["k7", 4], ["k8", 4], ["k9", 3], ["k10", 2], ["sync", 1]],
  LAR_MAX: [4.5, 4, 2.5, 2.5, 2, 2, 1.5, 1.5, 1.2, 1.2], // quantiser range for each log-area ratio
  qLar(v, i, bits) { const M = this.LAR_MAX[i], L = 1 << bits; return clamp(Math.floor((v + M) / (2 * M) * L), 0, L - 1); },
  dqLar(c, i, bits) { const M = this.LAR_MAX[i]; return -M + (c + 0.5) * 2 * M / (1 << bits); },
  // gain: code 0 is silence, 1–31 cover −66…0 dB in 2.2 dB steps
  qGain(rms) { const d = 20 * Math.log10(rms + 1e-12); return d < -67 ? 0 : clamp(Math.round((d + 66) / 2.2) + 1, 1, 31); },
  dqGain(c) { return c ? Math.pow(10, (-66 + (c - 1) * 2.2) / 20) : 0; },
  // pitch: code 0 is unvoiced, 1–127 are periods of 20–146 samples (400–55 Hz)
  MIN_LAG: 20, MAX_LAG: 146,
};
function levinson(R, p) { // reflection coefficients for the predictor x̂[n] = Σ a_j x[n−j]
  const k = new Float64Array(p), a = new Float64Array(p + 1);
  let err = R[0];
  for (let i = 1; i <= p; i++) {
    if (err <= 0) break;
    let acc = R[i];
    for (let j = 1; j < i; j++) acc -= a[j] * R[i - j];
    const ki = acc / err, prev = a.slice();
    k[i - 1] = ki; a[i] = ki;
    for (let j = 1; j < i; j++) a[j] = prev[j] - ki * prev[i - j];
    err *= 1 - ki * ki;
  }
  return k;
}
// normalised autocorrelation over 300 samples around c; the best lag is the pitch period
function lpcPitch(s, c) {
  const a = Math.max(0, c - 150), b = Math.min(s.length, c + 150), rs = new Float64Array(LPC.MAX_LAG + 2);
  let best = 0, lag = 0;
  for (let L = LPC.MIN_LAG; L <= LPC.MAX_LAG; L++) {
    let xy = 0, xx = 0, yy = 0;
    for (let i = a; i + L < b; i++) { xy += s[i] * s[i + L]; xx += s[i] * s[i]; yy += s[i + L] * s[i + L]; }
    rs[L] = xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0;
    if (rs[L] > best) { best = rs[L]; lag = L; }
  }
  // the correlation also peaks at 2 and 3 periods: prefer a shorter lag that is nearly as good
  for (const d of [3, 2]) {
    const L = Math.round(lag / d);
    if (L < LPC.MIN_LAG) continue;
    const m = Math.max(rs[L - 1] || 0, rs[L], rs[L + 1] || 0);
    if (m > 0.85 * best) { lag = rs[L - 1] === m ? L - 1 : rs[L + 1] === m ? L + 1 : L; break; }
  }
  return { lag, voiced: best > 0.5 };
}

// ---------- codecs ----------
// values: the settings the slider steps through, best first (slider right = lower bit rate).
// Sample codecs pack frameLen samples per 20 ms frame; the vocoder brings its own encode/decode.
const pcmCodec = rate => ({
  rate, frameLen: rate / 50, values: [16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2], def: 8, unit: "bits",
  sampleBits: p => p, frameBits: p => p * rate / 50,
  newState: () => null,
  encodeSample: (s, v, p) => clamp(Math.round(v * (1 << (p - 1))), -(1 << (p - 1)), (1 << (p - 1)) - 1) & ((1 << p) - 1),
  readSample: (s, r, p) => r.getSigned(p) / (1 << (p - 1)),
  levels: p => { const h = 1 << (p - 1), L = new Float32Array(2 * h); for (let k = 0; k < 2 * h; k++) L[k] = (k - h) / h; return L; },
  describe: p => `${rate / 1000} kHz × ${p} bits, 20 ms frames of ${rate / 50} samples`,
  waveform: true,
});
const g711Codec = (enc, dec, name) => ({
  rate: 8000, frameLen: 160, values: null, fixed: "64 kbit/s",
  sampleBits: () => 8, frameBits: () => 1280,
  newState: () => null,
  encodeSample: (s, v) => enc(toPcm16(v)),
  readSample: (s, r) => dec(r.get(8)) / 32768,
  levels: () => Float32Array.from(new Set(Array.from({ length: 256 }, (_, u) => dec(u) / 32768))).sort(),
  describe: () => `8 kHz × 8-bit ${name}, 20 ms frames of 160 samples`,
  waveform: true,
});
const CODECS = {
  pcm8: pcmCodec(8000),
  pcm16: pcmCodec(16000),
  ulaw: g711Codec(linear2ulaw, ulaw2linear, "μ-law"),
  alaw: g711Codec(linear2alaw, alaw2linear, "A-law"),
  g726: {
    rate: 8000, frameLen: 160, values: [40, 32, 24, 16], def: 32, unit: "kbit/s",
    sampleBits: p => G726.RATES[p].bits, frameBits: p => 160 * G726.RATES[p].bits,
    newState: () => G726.newState(),
    encodeSample: (s, v, p) => G726.encode(s, G726.RATES[p], toPcm16(v)),
    readSample: (s, r, p) => G726.decode(s, G726.RATES[p], r.get(G726.RATES[p].bits)) / 32768,
    // prediction, and the largest move one code can make from it: 2^((largest log level + y/4) / 128), 14-bit units
    probe: (s, p) => ({ pred: s.se / 8192, band: Math.pow(2, (Math.max(...G726.RATES[p].dqln) + (s.y >> 2)) / 128) / 8192 }),
    describe: p => `8 kHz × ${G726.RATES[p].bits}-bit ADPCM, 20 ms frames, no resync`,
    waveform: true,
  },
  ima: {
    rate: 8000, frameLen: 160, values: null, fixed: "33.2 kbit/s",
    sampleBits: () => 4, frameBits: () => 24 + 160 * 4,
    newState: () => ({ pred: 0, index: 0 }),
    // each frame starts with the predictor (16 bits) and step index (8 bits)
    encodeHeader(s, w) { w.put(s.pred & 0xFFFF, 16); w.put(s.index, 8); },
    readHeader(s, r) { s.pred = r.getSigned(16); s.index = Math.min(88, r.get(8)); },
    encodeSample: (s, v) => imaEncode(s, toPcm16(v)),
    readSample(s, r) { s.lastPred = s.pred; s.lastStep = IMA_STEPS[s.index]; imaApply(s, r.get(4)); return s.pred / 32768; },
    probe: s => ({ pred: s.lastPred / 32768, band: s.lastStep * 1.875 / 32768 }), // largest move: step × (1 + 1/2 + 1/4 + 1/8)
    describe: () => "8 kHz × 4 bits, 20 ms frames, each with a 24-bit state header",
    waveform: true,
  },
  lpc: {
    rate: 8000, values: [2400, 1200, 600], def: 2400, unit: "bit/s",
    frameLen: p => ({ 2400: 180, 1200: 360, 600: 720 })[p],
    frameBits: () => 54,
    describe: p => `54 bits per ${22.5 * 2400 / p} ms: pitch 7, gain 5, filter 41, sync 1`,
    waveform: false,
    encode(x, p) {
      const F = this.frameLen(p), N = x.length, nf = Math.ceil(N / F), w = new BitWriter(nf * 54);
      const pe = new Float32Array(N);
      for (let i = 0; i < N; i++) pe[i] = x[i] - LPC.preEmph * (i ? x[i - 1] : 0);
      const lp = biquad(x, "lp", 900, 8000), W = LPC.win, ham = new Float64Array(W), R = new Float64Array(LPC.order + 1);
      for (let i = 0; i < W; i++) ham[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (W - 1));
      for (let f = 0; f < nf; f++) {
        const s0 = f * F, c = s0 + F / 2;
        let e = 0;
        for (let i = s0; i < Math.min(s0 + F, N); i++) e += pe[i] * pe[i];
        const gain = LPC.qGain(Math.sqrt(e / F));
        // autocorrelation of the windowed, pre-emphasised signal; a −40 dB floor keeps the filter stable
        const seg = new Float64Array(W);
        for (let i = 0; i < W; i++) { const t = c - W / 2 + i; seg[i] = t >= 0 && t < N ? pe[t] * ham[i] : 0; }
        for (let j = 0; j <= LPC.order; j++) { let s = 0; for (let i = j; i < W; i++) s += seg[i] * seg[i - j]; R[j] = s; }
        R[0] *= 1.0001;
        const k = R[0] > 1e-12 ? levinson(R, LPC.order) : new Float64Array(LPC.order);
        const { lag, voiced } = lpcPitch(lp, c);
        w.put(voiced && gain ? lag - LPC.MIN_LAG + 1 : 0, 7);
        w.put(gain, 5);
        for (let i = 0; i < LPC.order; i++) {
          const ki = clamp(k[i], -0.999, 0.999), bits = LPC.FIELDS[i + 2][1];
          w.put(LPC.qLar(Math.log((1 + ki) / (1 - ki)), i, bits), bits);
        }
        w.put(f & 1, 1);
      }
      return w.b;
    },
    decode(bits, lost, conceal, p, n, tr = {}) {
      const F = this.frameLen(p), nf = lost.length, P = [], r = new BitReader(bits);
      Object.assign(tr, { frames: P, F, pulses: [] });
      for (let f = 0; f < nf; f++) {
        r.p = f * 54;
        if (lost[f]) {
          const prev = P[f - 1];
          // concealment: silence, or the previous frame's parameters, fading 6 dB per lost frame
          P.push(conceal === "silence" || !prev ? { lag: 0, rms: 0, lar: new Float64Array(LPC.order) }
            : { ...prev, rms: conceal === "fade" ? prev.rms * 0.5 : prev.rms });
          continue;
        }
        const pc = r.get(7), rms = LPC.dqGain(r.get(5)), lar = new Float64Array(LPC.order);
        for (let i = 0; i < LPC.order; i++) { const b = LPC.FIELDS[i + 2][1]; lar[i] = LPC.dqLar(r.get(b), i, b); }
        P.push({ lag: pc ? pc - 1 + LPC.MIN_LAG : 0, rms, lar });
      }
      // synthesis: pulse train (voiced) or noise (unvoiced), through the all-pole lattice filter.
      // Filter and gain are interpolated between frame centres; voicing and pitch follow the current frame.
      const y = new Float32Array(n), M = LPC.order, k = new Float64Array(M), bd = new Float64Array(M + 1);
      const rnd = mulberry32(99);
      let count = 0, norm = 1, rms = 0, prevOut = 0;
      for (let t = 0; t < n; t++) {
        const u = (t - F / 2) / F, fu = Math.floor(u);
        const i0 = clamp(fu, 0, nf - 1), i1 = clamp(fu + 1, 0, nf - 1), fr = u < 0 ? 0 : u - fu;
        if (t % 8 === 0) { // update the filter every 1 ms
          norm = 1;
          for (let i = 0; i < M; i++) {
            k[i] = Math.tanh((P[i0].lar[i] * (1 - fr) + P[i1].lar[i] * fr) / 2);
            norm *= 1 - k[i] * k[i];
          }
          norm = Math.sqrt(norm);
          rms = P[i0].rms * (1 - fr) + P[i1].rms * fr;
        }
        const cur = P[Math.min(nf - 1, Math.floor(t / F))];
        let e;
        if (cur.lag) { // one unit-power pulse per period
          if (count <= 0) { e = Math.sqrt(cur.lag); count += cur.lag; tr.pulses.push(t); } else e = 0;
          count--;
        } else { e = (rnd() * 2 - 1) * Math.sqrt(3); count = 0; }
        let v = e * rms * norm;
        for (let i = M; i >= 1; i--) { v += k[i - 1] * bd[i - 1]; bd[i] = bd[i - 1] - k[i - 1] * v; }
        bd[0] = v;
        prevOut = v + LPC.preEmph * prevOut;  // de-emphasis
        y[t] = prevOut;
      }
      return y;
    },
  },
};

// generic encoder for the sample codecs: frames of frameLen samples, each optionally with a header
function encodeSamples(c, x, p) {
  const F = c.frameLen, nf = Math.ceil(x.length / F), w = new BitWriter(nf * c.frameBits(p)), s = c.newState(p);
  for (let f = 0; f < nf; f++) {
    if (c.encodeHeader) c.encodeHeader(s, w);
    for (let i = f * F; i < (f + 1) * F; i++) w.put(c.encodeSample(s, i < x.length ? x[i] : 0, p), c.sampleBits(p));
  }
  return w.b;
}
function decodeSamples(c, bits, lost, conceal, p, n, tr = {}) {
  const F = c.frameLen, nf = lost.length, fb = c.frameBits(p), y = new Float32Array(nf * F), s = c.newState(p);
  // ADPCM: the decoder's prediction and step band per sample, NaN where frames were lost
  const pred = c.probe ? new Float32Array(nf * F).fill(NaN) : null, band = pred && new Float32Array(nf * F).fill(NaN);
  for (let f = 0; f < nf; f++) {
    const o = f * F;
    if (lost[f]) { // decoder state is left as it was; the gap is filled from the previous output
      if (conceal !== "silence" && f > 0) {
        const g = conceal === "fade" ? 0.5 : 1;
        for (let i = 0; i < F; i++) y[o + i] = g * y[o - F + i];
      }
      continue;
    }
    const r = new BitReader(bits, f * fb);
    if (c.readHeader) c.readHeader(s, r);
    for (let i = 0; i < F; i++) {
      y[o + i] = c.readSample(s, r, p);
      if (pred) { const q = c.probe(s, p); pred[o + i] = q.pred; band[o + i] = q.band; }
    }
  }
  if (pred) { tr.pred = pred.subarray(0, n); tr.band = band.subarray(0, n); }
  return y.subarray(0, n);
}
const frameLenOf = (c, p) => typeof c.frameLen === "function" ? c.frameLen(p) : c.frameLen;

// ---------- channel ----------
function flipBits(bits, ber, seed) { // independent errors; the gap to the next error is geometric
  const rnd = mulberry32(seed), L = Math.log1p(-ber);
  let i = -1, k = 0;
  for (;;) {
    i += 1 + Math.floor(Math.log(1 - rnd()) / L);
    if (i >= bits.length) return k;
    bits[i] ^= 1; k++;
  }
}
function lossPattern(nf, pct, burst, seed) {
  const rnd = mulberry32(seed), lost = new Uint8Array(nf), p = pct / 100;
  if (!burst) { for (let f = 0; f < nf; f++) lost[f] = rnd() < p ? 1 : 0; return lost; }
  // Gilbert model: a bad state that loses every frame, left with probability 1/3 (mean run 3 frames),
  // entered at the rate that gives the requested average loss
  const leave = 1 / 3, enter = Math.min(1, p / (1 - p) * leave);
  let bad = false;
  for (let f = 0; f < nf; f++) { bad = bad ? rnd() >= leave : rnd() < enter; lost[f] = bad ? 1 : 0; }
  return lost;
}

// ---------- measurement (at the codec rate) ----------
function measure(ref, dec, rate) {
  const n = ref.length, err = new Float32Array(n);
  for (let i = 0; i < n; i++) err[i] = dec[i] - ref[i];
  const Pe = power(err), snr = Pe > 0 ? dB(power(ref) / Pe) : Infinity;
  // 20 ms frames; frames more than 40 dB below the loudest are skipped
  const L = rate / 50, nf = Math.floor(n / L), Ef = new Float64Array(nf);
  let Emax = 0;
  for (let f = 0; f < nf; f++) { let e = 0; for (let i = f * L; i < (f + 1) * L; i++) e += ref[i] * ref[i]; Ef[f] = e; Emax = Math.max(Emax, e); }
  const use = f => Ef[f] > Emax * 1e-4;
  let seg = 0, cnt = 0;
  for (let f = 0; f < nf; f++) {
    if (!use(f)) continue;
    let e = 0; for (let i = f * L; i < (f + 1) * L; i++) e += err[i] * err[i];
    seg += e > 0 ? clamp(dB(Ef[f] / e), -10, 35) : 35; cnt++;
  }
  // spectral distortion: energy in third-octave bands from 250 Hz up to the codec's bandwidth,
  // RMS dB difference per frame; bands more than 60 dB below the loudest are floored
  const NF = rate === 8000 ? 256 : 512, binHz = rate / NF, win = new Float64Array(L), edges = [];
  for (let i = 0; i < L; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / L);
  for (let fc = 250; fc <= 0.425 * rate; fc *= Math.pow(2, 1 / 3)) edges.push([fc * Math.pow(2, -1 / 6), fc * Math.pow(2, 1 / 6)]);
  const bands = (a, o) => {
    const re = new Float64Array(NF), im = new Float64Array(NF), e = new Float64Array(edges.length);
    for (let i = 0; i < L; i++) re[i] = a[o + i] * win[i];
    fft(re, im);
    edges.forEach(([lo, hi], b) => {
      for (let k = Math.ceil(lo / binHz); k * binHz < hi; k++) e[b] += re[k] * re[k] + im[k] * im[k];
    });
    return e;
  };
  const frames = [];
  let maxBand = 0;
  for (let f = 0; f < nf; f++) {
    if (!use(f)) continue;
    const br = bands(ref, f * L);
    for (const v of br) maxBand = Math.max(maxBand, v);
    frames.push([br, bands(dec, f * L)]);
  }
  const floor = maxBand * 1e-6;
  let sd = 0;
  for (const [br, bd] of frames) {
    let s = 0;
    for (let b = 0; b < edges.length; b++) { const d = dB(Math.max(br[b], floor) / Math.max(bd[b], floor)); s += d * d; }
    sd += Math.sqrt(s / edges.length);
  }
  return { err, snr, seg: cnt ? seg / cnt : NaN, sd: frames.length ? sd / frames.length : NaN };
}

// ---------- FFT ----------
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, ang = -2 * Math.PI / len;
    for (let j = 0; j < half; j++) {
      const wr = Math.cos(ang * j), wi = Math.sin(ang * j);
      for (let i = j; i < n; i += len) {
        const k = i + half, vr = re[k] * wr - im[k] * wi, vi = re[k] * wi + im[k] * wr;
        re[k] = re[i] - vr; im[k] = im[i] - vi; re[i] += vr; im[i] += vi;
      }
    }
  }
}
const NFFT = 4096;
const HANN = (() => { const w = new Float64Array(NFFT); for (let i = 0; i < NFFT; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT); return w; })();
function welch(x) {
  const hop = NFFT / 2, frames = Math.max(1, Math.floor((x.length - NFFT) / hop) + 1);
  const step = Math.max(1, Math.ceil(frames / 60));
  const acc = new Float64Array(NFFT / 2 + 1), re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  let count = 0, wsum = 0;
  for (let i = 0; i < NFFT; i++) wsum += HANN[i];
  for (let f = 0; f < frames; f += step) {
    const o = f * hop;
    for (let i = 0; i < NFFT; i++) { re[i] = (x[o + i] || 0) * HANN[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= NFFT / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    count++;
  }
  const ref = (wsum / 2) * (wsum / 2); // a full-scale sine peaks at 0 dBFS
  const out = new Float64Array(acc.length);
  for (let k = 0; k < acc.length; k++) out[k] = dB(acc[k] / count / ref + 1e-30);
  return out;
}
