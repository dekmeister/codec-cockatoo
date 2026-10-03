"use strict";
// Codec Cockatoo: state, source loading, the processing chain, playback, plots and controls.
// Needs dsp.js loaded first (helpers, codecs, channel, measurement, FFT).

// ---------- small helpers ----------
const $ = id => document.getElementById(id);
const fmtDb = v => !isFinite(v) ? (v > 0 ? "∞" : "−∞") : v.toFixed(1) + " dB";
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// ---------- state ----------
const MAX_SECONDS = 20;
const S = {
  ac: null, sr: 48000,
  sources: {},          // name -> Float32Array (mono, normalised)
  srcName: null, x: null, peak: 1,
  res: null,            // { out, err, lost, ... }
  play: { node: null, gain: null, startedAt: 0, pos: 0 },
  zoomLen: 0.02, zoomCenter: null,
  overviewCache: null,
};
function audioCtx() {
  if (!S.ac) {
    // 48 kHz gives exact 6:1 and 3:1 ratios to the codec rates
    const AC = window.AudioContext || window.webkitAudioContext;
    try { S.ac = new AC({ sampleRate: 48000 }); } catch (_) { S.ac = new AC(); }
    S.sr = S.ac.sampleRate;
  }
  return S.ac;
}

// ---------- source loading ----------
function toMono(buf) {
  const n = Math.min(buf.length, Math.round(MAX_SECONDS * buf.sampleRate));
  const out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  // remove DC, normalise to -3 dBFS peak
  let mean = 0; for (let i = 0; i < n; i++) mean += out[i]; mean /= n || 1;
  for (let i = 0; i < n; i++) out[i] -= mean;
  const p = peakOf(out) || 1, g = Math.pow(10, -3 / 20) / p;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}
function makeTone() {
  const sr = S.sr, n = Math.round(5 * sr), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 1020 * i / sr);
  return x;
}
async function fetchBundled(name) {
  for (const ext of ["wav", "mp3", "ogg", "flac", "m4a", "opus"]) {
    try {
      const r = await fetch(`audio/${name}.${ext}`);
      if (r.ok) return { data: await r.arrayBuffer(), file: `${name}.${ext}` };
    } catch (_) { /* file:// or network error: try the next */ }
  }
  return null;
}
async function decode(arrayBuf) {
  const buf = await audioCtx().decodeAudioData(arrayBuf);
  return toMono(buf);
}

// ---------- the processing chain ----------
// source (48 kHz) → anti-alias filter + decimate → encode → bit errors → frame loss → decode → interpolate
function readSettings() {
  return {
    codecOn: $("codecOn").checked, codec: $("codec").value, param: +$("paramNum").value,
    lossOn: $("lossOn").checked, loss: +$("lossNum").value, burst: $("burst").checked, conceal: $("conceal").value,
    berOn: $("berOn").checked, ber: +$("berNum").value,
  };
}
function processAudio() {
  const x = S.x; if (!x) return;
  const n = x.length, st = readSettings(), c = CODECS[st.codec], R = S.sr / (c ? c.rate : 1);
  if (!st.codecOn || !Number.isInteger(R)) {
    S.res = { out: x, err: new Float32Array(n), lost: null, st, off: true,
      note: st.codecOn ? `The codecs need audio at 48 kHz; this browser runs at ${S.sr} Hz.` : "" };
  } else {
    // reference: the source through the anti-alias filter, at the codec rate
    if (!S.ref || S.ref.x !== x || S.ref.rate !== c.rate) S.ref = { x, rate: c.rate, y: decimate(x, R) };
    const ref = S.ref.y;
    // encoding is cached, so channel changes only rerun the decoder
    const eKey = [st.codec, st.param].join("|");
    if (!S.enc || S.enc.x !== x || S.enc.key !== eKey)
      S.enc = { x, key: eKey, bits: c.encode ? c.encode(ref, st.param) : encodeSamples(c, ref, st.param) };
    const F = frameLenOf(c, st.param), fb = c.frameBits(st.param), nf = Math.ceil(ref.length / F);
    let bits = S.enc.bits, nErr = 0;
    if (st.berOn && st.ber > 0) { bits = Uint8Array.from(bits); nErr = flipBits(bits, st.ber, 777); }
    const lost = st.lossOn && st.loss > 0 ? lossPattern(nf, st.loss, st.burst, 4242) : new Uint8Array(nf);
    const tr = {};
    const dec = c.decode ? c.decode(bits, lost, st.conceal, st.param, ref.length, tr)
      : decodeSamples(c, bits, lost, st.conceal, st.param, ref.length, tr);
    const m = measure(ref, dec, c.rate);
    let nLost = 0; for (let f = 0; f < nf; f++) nLost += lost[f];
    S.res = {
      out: interpolate(dec, R, n), err: interpolate(m.err, R, n), lost, F48: F * R, st,
      rate: fb * c.rate / F, frameMs: 1000 * F / c.rate, nf, nLost, nErr, nBits: bits.length,
      snr: m.snr, seg: m.seg, sd: m.sd, waveform: c.waveform, note: c.describe(st.param),
      dec, trace: tr, R, F, codec: c, cutoff: 0.425 * c.rate,
    };
  }
  S.res.id = (S.resId = (S.resId || 0) + 1);
  S.spec = null;
  $("legErr").classList.toggle("dim", S.res.waveform === false);
  buildBuffer();
  if (S.play.node) play(); // swap the new audio in straight away
  updateReadouts();
  cancelAnimationFrame(S.drawReq);
  S.drawReq = requestAnimationFrame(drawAll); // plots follow a frame later
}

// ---------- playback ----------
function buildBuffer() {
  const out = S.res.out;
  // steady level per source; only turned down if the output would clip
  const g = Math.min(0.6 / S.peak, 0.95 / (peakOf(out) || 1));
  const b = audioCtx().createBuffer(1, out.length, S.sr), d = b.getChannelData(0);
  for (let i = 0; i < out.length; i++) d[i] = out[i] * g;
  S.buffer = b;
}
const FADE = 0.03; // short crossfade avoids clicks when settings change mid-play
function playPos() {
  const p = S.play;
  if (!p.node) return p.pos;
  const dur = S.x.length / S.sr;
  return ((audioCtx().currentTime - p.startedAt) % dur + dur) % dur;
}
function fadeOut({ node, gain }) {
  const t = audioCtx().currentTime;
  gain.gain.cancelScheduledValues(t);
  gain.gain.setValueAtTime(gain.gain.value, t);
  gain.gain.linearRampToValueAtTime(0, t + FADE);
  node.stop(t + FADE + 0.01);
}
// iOS/iPadOS treats Web Audio as "ambient" audio, which the hardware silent switch mutes.
// Ask for a "playback" session instead (Safari 16.4+), and on older iOS get the same
// effect by playing a silent <audio> clip, which is an inaudible side effect only.
function playbackSession() {
  try { navigator.audioSession.type = "playback"; } catch (_) {}
  if (S.silent === undefined) {
    try {
      const n = 800, b = new DataView(new ArrayBuffer(44 + n)), w = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
      w(0, "RIFF"); b.setUint32(4, 36 + n, true); w(8, "WAVEfmt "); b.setUint32(16, 16, true);
      b.setUint16(20, 1, true); b.setUint16(22, 1, true); b.setUint32(24, 8000, true);
      b.setUint32(28, 8000, true); b.setUint16(32, 1, true); b.setUint16(34, 8, true);
      w(36, "data"); b.setUint32(40, n, true);
      for (let i = 0; i < n; i++) b.setUint8(44 + i, 128); // 8-bit silence
      S.silent = new Audio(URL.createObjectURL(new Blob([b], { type: "audio/wav" })));
      S.silent.loop = true;
    } catch (_) { S.silent = null; }
  }
  if (S.silent) S.silent.play().catch(() => {});
}
function play() {
  if (!S.buffer) return;
  playbackSession();
  const ac = audioCtx(); ac.resume();
  const pos = playPos(), t = ac.currentTime;
  if (S.play.node) fadeOut(S.play);
  const node = ac.createBufferSource(), gain = ac.createGain();
  node.buffer = S.buffer; node.loop = true;
  node.connect(gain).connect(ac.destination);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(1, t + FADE);
  node.start(t, pos);
  Object.assign(S.play, { node, gain, startedAt: t - pos });
  updateTransport();
  requestAnimationFrame(tick);
}
function pause() {
  if (S.play.node) { S.play.pos = playPos(); fadeOut(S.play); S.play.node = null; }
  if (S.silent) S.silent.pause();
  updateTransport(); drawOverview(); if (specMode === "wf") drawSpectrum();
}
function stop() { pause(); S.play.pos = 0; drawOverview(); if (specMode === "wf") drawSpectrum(); }
function updateTransport() {
  $("playBtn").classList.toggle("on", !!S.play.node);
  $("pauseBtn").classList.toggle("on", !S.play.node && S.play.pos > 0);
}
function tick() { if (S.play.node) { drawOverview(); if (specMode === "wf") drawSpectrum(); requestAnimationFrame(tick); } }

// ---------- canvas plumbing ----------
function prep(canvas) {
  const dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const c = canvas.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { c, w: r.width, h: r.height };
}
const colors = () => ({ orig: cssVar("--orig"), deg: cssVar("--deg"), err: cssVar("--err"), lost: cssVar("--lost"),
  level: cssVar("--level"), band: cssVar("--band"), unv: cssVar("--unv"),
  grid: cssVar("--grid"), muted: cssVar("--muted"), text: cssVar("--text"), accent: cssVar("--accent") });
// shade lost frames that overlap samples [i0, i0 + len) on a plot w px wide
function shadeLost(c, i0, len, w, h, color) {
  const r = S.res; if (!r.lost) return;
  c.fillStyle = color;
  const f0 = Math.floor(i0 / r.F48), f1 = Math.min(r.lost.length - 1, Math.floor((i0 + len) / r.F48));
  for (let f = f0; f <= f1; f++) {
    if (!r.lost[f]) continue;
    const a = (f * r.F48 - i0) / len * w, b = ((f + 1) * r.F48 - i0) / len * w;
    c.fillRect(Math.max(0, a), 0, Math.max(1, Math.min(w, b) - Math.max(0, a)), h);
  }
}

// overview: min/max envelopes cached to an offscreen canvas, playhead drawn on top
function renderOverviewCache() {
  const cv = $("overview"), { w, h } = prep(cv), dpr = window.devicePixelRatio || 1;
  const off = document.createElement("canvas"); off.width = cv.width; off.height = cv.height;
  const c = off.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const col = colors(), x = S.x, y = S.res.out, n = x.length, cols = Math.floor(w), mid = h / 2;
  shadeLost(c, 0, n, w, h, col.lost);
  let scale = Math.max(peakOf(x), peakOf(y)) || 1; scale = (h / 2 - 2) / scale;
  const env = (a, color, alpha) => {
    c.fillStyle = color; c.globalAlpha = alpha; c.beginPath();
    const mins = [];
    for (let px = 0; px < cols; px++) {
      const i0 = Math.floor(px * n / cols), i1 = Math.max(i0 + 1, Math.floor((px + 1) * n / cols));
      let mn = 0, mx = 0;
      for (let i = i0; i < i1; i++) { const v = a[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      c.lineTo(px, mid - mx * scale); mins.push(mn);
    }
    for (let px = cols - 1; px >= 0; px--) c.lineTo(px, mid - mins[px] * scale);
    c.closePath(); c.fill(); c.globalAlpha = 1;
  };
  env(y, col.deg, 0.75);
  env(x, col.orig, 0.9);
  S.overviewCache = off;
}
function drawOverview() {
  const cv = $("overview"); if (!S.res) return;
  const { c, w, h } = prep(cv);
  if (!S.overviewCache || S.overviewCache.width !== cv.width) renderOverviewCache();
  c.clearRect(0, 0, w, h);
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(S.overviewCache, 0, 0); c.restore();
  const dur = S.x.length / S.sr, col = colors();
  // zoom window
  const z0 = zoomStart(), x0 = z0 / S.x.length * w, x1 = (z0 + zoomSamples()) / S.x.length * w;
  c.fillStyle = col.accent; c.globalAlpha = 0.18;
  c.fillRect(Math.min(x0, w - 3), 0, Math.max(3, x1 - x0), h); c.globalAlpha = 1;
  c.strokeStyle = col.accent; c.lineWidth = 1; c.strokeRect(Math.min(x0, w - 3) + 0.5, 0.5, Math.max(3, x1 - x0) - 1, h - 1);
  // playhead
  if (S.play.node || S.play.pos > 0) {
    const px = playPos() / dur * w;
    c.strokeStyle = col.text; c.lineWidth = 1.5; c.beginPath(); c.moveTo(px, 0); c.lineTo(px, h); c.stroke();
  }
}

function zoomSamples() { return Math.min(S.x.length, Math.max(8, Math.round(S.zoomLen * S.sr))); }
function zoomStart() {
  const len = zoomSamples();
  return Math.max(0, Math.min(S.x.length - len, Math.round(S.zoomCenter - len / 2)));
}
// ---------- codec detail (zoom overlay) ----------
// Draws only values the decoder already computed: its samples at the codec rate, the quantiser levels,
// the ADPCM prediction and step band, and the vocoder's frames, voicing and pitch pulses.
const LEVELS = {};
function levelsOf(r) {
  if (!r.codec.levels) return null;
  const key = r.st.codec + "|" + r.st.param;
  return LEVELS[key] || (LEVELS[key] = r.codec.levels(r.st.param));
}
function drawDetail(c, phase, i0, len, w, h, mid, sy, col) {
  const r = S.res;
  if (r.off || !$("detailOn").checked) return;
  const R = r.R, tr = r.trace, xOf = i => len > 1 ? (i - i0) * w / (len - 1) : 0;
  const t0 = Math.max(0, Math.floor(i0 / R) - 1), t1 = Math.min(r.dec.length - 1, Math.ceil((i0 + len) / R) + 1);
  const stepPx = R * w / len; // pixels per codec sample
  if (phase === "under") {
    if (tr.frames) { // vocoder: unvoiced frames shaded
      const FR = tr.F * R;
      c.fillStyle = col.unv;
      for (let f = Math.floor(i0 / FR); f <= Math.min(tr.frames.length - 1, Math.floor((i0 + len) / FR)); f++) {
        if (tr.frames[f].lag) continue;
        const a = Math.max(0, xOf(f * FR)), b = Math.min(w, xOf((f + 1) * FR));
        c.fillRect(a, 0, b - a, h);
      }
    }
    const L = levelsOf(r);
    if (L) { // quantiser levels: a line each where at least 3 px apart, a tint where denser
      const ys = [];
      for (const v of L) { const y = mid - v * sy; if (y >= -5 && y <= h + 5) ys.push(y); }
      ys.sort((p, q) => p - q);
      c.strokeStyle = col.level; c.fillStyle = col.band; c.lineWidth = 1; c.beginPath();
      let dense = 0;
      for (let i = 0; i < ys.length; i++) {
        const gap = Math.min(i ? ys[i] - ys[i - 1] : Infinity, i < ys.length - 1 ? ys[i + 1] - ys[i] : Infinity);
        if (gap >= 3) { const yy = Math.round(ys[i]) + 0.5; c.moveTo(0, yy); c.lineTo(w, yy); }
        else { dense++; if (i < ys.length - 1 && ys[i + 1] - ys[i] < 3) c.fillRect(0, ys[i], w, ys[i + 1] - ys[i]); }
      }
      c.stroke();
      if (dense && dense === ys.length) {
        c.fillStyle = col.muted; c.font = "11px system-ui, sans-serif"; c.textAlign = "left";
        c.fillText("quantiser levels too close to draw individually", 6, 14);
      }
    }
    if (tr.band) { // ADPCM: prediction ± the largest move one code can make
      c.fillStyle = col.band;
      for (let t = t0; t <= t1; t++) {
        const p = tr.pred[t], b = tr.band[t];
        if (isNaN(p)) continue;
        const a = xOf(t * R - R / 2), e = xOf(t * R + R / 2);
        c.fillRect(a, mid - (p + b) * sy, e - a, 2 * b * sy);
      }
    }
    return;
  }
  // over the traces
  if (tr.pred) { // the prediction, held for each codec sample
    c.strokeStyle = col.text; c.lineWidth = 1; c.setLineDash([3, 2]); c.beginPath();
    let on = false;
    for (let t = t0; t <= t1; t++) {
      const p = tr.pred[t];
      if (isNaN(p)) { on = false; continue; }
      const a = xOf(t * R - R / 2), e = xOf(t * R + R / 2), y = mid - p * sy;
      on ? c.lineTo(a, y) : c.moveTo(a, y);
      c.lineTo(e, y); on = true;
    }
    c.stroke(); c.setLineDash([]);
  }
  if (r.waveform && stepPx >= 3) { // the decoded samples at the codec rate
    c.fillStyle = col.deg;
    const rad = stepPx >= 8 ? 2.5 : 1.5;
    for (let t = t0; t <= t1; t++) { c.beginPath(); c.arc(xOf(t * R), mid - r.dec[t] * sy, rad, 0, 2 * Math.PI); c.fill(); }
  }
  if (tr.frames) { // frame boundaries and pitch pulses
    const FR = tr.F * R;
    c.strokeStyle = col.muted; c.lineWidth = 1; c.setLineDash([4, 3]); c.beginPath();
    for (let f = Math.ceil(i0 / FR); f * FR <= i0 + len; f++) { const x = Math.round(xOf(f * FR)) + 0.5; c.moveTo(x, 0); c.lineTo(x, h); }
    c.stroke(); c.setLineDash([]);
    c.strokeStyle = col.deg; c.lineWidth = 1.5; c.beginPath();
    for (const t of tr.pulses) { if (t < t0) continue; if (t > t1) break; const x = xOf(t * R); c.moveTo(x, h); c.lineTo(x, h - 8); }
    c.stroke();
  }
}

function drawZoom() {
  const { c, w, h } = prep($("zoom")); c.clearRect(0, 0, w, h);
  if (!S.res) return;
  const col = colors(), i0 = zoomStart(), len = zoomSamples();
  shadeLost(c, i0, len, w, h, col.lost);
  // a vocoder doesn't keep the waveform, so its error trace is faded
  const tr = [[S.x, col.orig, 3, 1], [S.res.out, col.deg, 1.5, 1], [S.res.err, col.err, 1.2, S.res.waveform === false ? 0.3 : 1]];
  let pk = 0;
  for (const [a] of tr) for (let i = i0; i < i0 + len; i++) pk = Math.max(pk, Math.abs(a[i]));
  pk = Math.max(pk, 1e-4) * 1.1;
  const mid = h / 2, sy = (h / 2) / pk;
  drawDetail(c, "under", i0, len, w, h, mid, sy, col);
  // grid
  c.strokeStyle = col.grid; c.lineWidth = 1;
  c.beginPath(); c.moveTo(0, mid); c.lineTo(w, mid); c.stroke();
  for (let k = 1; k < 10; k++) { const gx = Math.round(k * w / 10) + 0.5; c.beginPath(); c.moveTo(gx, 0); c.lineTo(gx, h); c.stroke(); }
  for (const [a, color, lw, alpha] of tr) {
    c.strokeStyle = color; c.lineWidth = lw; c.lineJoin = "round"; c.globalAlpha = alpha; c.beginPath();
    for (let i = 0; i < len; i++) {
      const px = len > 1 ? i * w / (len - 1) : 0, py = mid - a[i0 + i] * sy;
      i ? c.lineTo(px, py) : c.moveTo(px, py);
    }
    c.stroke(); c.globalAlpha = 1;
  }
  drawDetail(c, "over", i0, len, w, h, mid, sy, col);
  const t0 = i0 / S.sr;
  $("zoomLabel").innerHTML = `<b>Zoom</b> · ${t0.toFixed(3)}–${((i0 + len) / S.sr).toFixed(3)} s`;
}

// ---------- spectrum plot ----------
const SPEC = { fmin: 20, dbMin: -150, dbMax: 0, pad: { l: 42, r: 10, t: 10, b: 24 } };
// bottom panel: "avg" (whole clip), "win" (zoom window) or "wf" (live waterfall)
let specMode = "wf";
function drawSpectrum() { specMode === "avg" ? drawAverage() : specMode === "win" ? drawWindow() : drawWaterfall(); }
function onSpecHover(e) {
  if (!S.res) return;
  if (specMode === "avg") return onAvgHover(e);
  const r = $("spectrum").getBoundingClientRect();
  S.specHover = { x: e.clientX - r.left, y: e.clientY - r.top };
  drawSpectrum();
}
const fmtHz = f => f >= 1000 ? (f / 1000).toFixed(2) + " kHz" : f.toFixed(0) + " Hz";

function drawAverage() {
  const { c, w, h } = prep($("spectrum")); c.clearRect(0, 0, w, h);
  if (!S.res) return;
  if (S.specOrigFor !== S.x) { S.specOrig = welch(S.x); S.specOrigFor = S.x; }
  if (!S.spec) S.spec = { orig: S.specOrig, deg: welch(S.res.out), err: welch(S.res.err) };
  const col = colors(), P = SPEC.pad, fmax = S.sr / 2;
  const pw = w - P.l - P.r, ph = h - P.t - P.b;
  const fx = f => P.l + Math.log(f / SPEC.fmin) / Math.log(fmax / SPEC.fmin) * pw;
  const dy = v => P.t + (SPEC.dbMax - Math.max(SPEC.dbMin, Math.min(SPEC.dbMax, v))) / (SPEC.dbMax - SPEC.dbMin) * ph;
  // grid
  c.font = "11px system-ui, sans-serif"; c.lineWidth = 1;
  for (let v = SPEC.dbMin; v <= SPEC.dbMax; v += 25) {
    const y = Math.round(dy(v)) + 0.5;
    c.strokeStyle = col.grid; c.beginPath(); c.moveTo(P.l, y); c.lineTo(w - P.r, y); c.stroke();
    c.fillStyle = col.muted; c.textAlign = "right"; c.fillText(v, P.l - 6, y + 4);
  }
  for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    if (f > fmax) continue;
    const x = Math.round(fx(f)) + 0.5;
    c.strokeStyle = col.grid; c.beginPath(); c.moveTo(x, P.t); c.lineTo(x, h - P.b); c.stroke();
    c.fillStyle = col.muted; c.textAlign = "center"; c.fillText(f >= 1000 ? f / 1000 + "k" : f, x, h - 7);
  }
  c.save(); c.translate(11, P.t + ph / 2); c.rotate(-Math.PI / 2); c.textAlign = "center"; c.fillText("dBFS", 0, 0); c.restore();
  // traces: max of bins per pixel column so narrow peaks survive
  const binHz = S.sr / NFFT;
  const trace = (spec, color, lw) => {
    c.strokeStyle = color; c.lineWidth = lw; c.lineJoin = "round"; c.beginPath();
    let started = false;
    for (let px = 0; px <= pw; px++) {
      const fa = SPEC.fmin * Math.pow(fmax / SPEC.fmin, px / pw), fb = SPEC.fmin * Math.pow(fmax / SPEC.fmin, (px + 1) / pw);
      const ka = Math.max(1, Math.floor(fa / binHz)), kb = Math.min(spec.length - 1, Math.max(ka, Math.floor(fb / binHz)));
      let v = -Infinity; for (let k = ka; k <= kb; k++) if (spec[k] > v) v = spec[k];
      const y = dy(v);
      started ? c.lineTo(P.l + px, y) : (c.moveTo(P.l + px, y), started = true);
    }
    c.stroke();
  };
  c.save(); c.beginPath(); c.rect(P.l, P.t, pw, ph); c.clip();
  trace(S.spec.orig, col.orig, 2.5);
  trace(S.spec.deg, col.deg, 1.4);
  c.globalAlpha = S.res.waveform === false ? 0.3 : 1; trace(S.spec.err, col.err, 1.1); c.globalAlpha = 1;
  if (S.specHover) {
    c.strokeStyle = col.muted; c.setLineDash([3, 3]);
    c.beginPath(); c.moveTo(S.specHover.x + 0.5, P.t); c.lineTo(S.specHover.x + 0.5, h - P.b); c.stroke(); c.setLineDash([]);
  }
  c.restore();
}
function onAvgHover(e) {
  if (!S.spec) return;
  const r = $("spectrum").getBoundingClientRect(), x = e.clientX - r.left, P = SPEC.pad, pw = r.width - P.l - P.r;
  if (x < P.l || x > P.l + pw) { S.specHover = null; $("specReadout").textContent = ""; drawSpectrum(); return; }
  const f = SPEC.fmin * Math.pow((S.sr / 2) / SPEC.fmin, (x - P.l) / pw), k = Math.round(f / (S.sr / NFFT));
  S.specHover = { x };
  const v = a => a[k].toFixed(0);
  $("specReadout").textContent = `${f >= 1000 ? (f / 1000).toFixed(2) + " kHz" : f.toFixed(0) + " Hz"}  clean ${v(S.spec.orig)}  heard ${v(S.spec.deg)}  error ${v(S.spec.err)} dBFS`;
  drawSpectrum();
}

// ---- zoom-window spectrum: just the samples in the zoom view, linear 0–8 kHz
const LIN = { fmax: 8000, dbMin: -120, dbMax: 0, pad: { l: 42, r: 10, t: 10, b: 24 } };
function windowSpectra() {
  const i0 = zoomStart(), len = zoomSamples(), key = [S.res.id, i0, len].join("|");
  if (S.win && S.win.key === key) return S.win;
  let N = 1024; while (N < len) N <<= 1;
  const win = new Float64Array(len);
  let ws = 0, ws2 = 0;
  for (let i = 0; i < len; i++) { win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / len); ws += win[i]; ws2 += win[i] * win[i]; }
  const spec = a => {
    const re = new Float64Array(N), im = new Float64Array(N), out = new Float64Array(N / 2 + 1);
    for (let i = 0; i < len; i++) re[i] = a[i0 + i] * win[i];
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) out[k] = dB((re[k] * re[k] + im[k] * im[k]) / (ws / 2) ** 2 + 1e-30); // a sine of amplitude A peaks at A² (0 dBFS full scale)
    return out;
  };
  return (S.win = { key, N, ws, ws2, orig: spec(S.x), deg: spec(S.res.out), err: spec(S.res.err) });
}
// The decoded LPC envelope for the vocoder frame at the zoom centre, on the same scale as windowSpectra.
// Voiced: the level each harmonic should reach (a unit-power pulse train has harmonics of amplitude 2/√lag).
// Unvoiced: the expected noise level per bin of this FFT (unit-variance noise, spread over the codec band at 48 kHz).
function lpcEnvelope(W) {
  const r = S.res, tr = r.trace;
  if (r.off || !tr.frames || !$("detailOn").checked) return null;
  const f = clamp(Math.floor(S.zoomCenter / r.R / tr.F), 0, tr.frames.length - 1), P = tr.frames[f];
  if (!P.rms) return null;
  const M = LPC.order, a = new Float64Array(M + 1);
  let norm = 1;
  for (let i = 1; i <= M; i++) { // reflection coefficients → predictor, as in the decoder
    const k = Math.tanh(P.lar[i - 1] / 2), prev = a.slice();
    a[i] = k;
    for (let j = 1; j < i; j++) a[j] = prev[j] - k * prev[i - j];
    norm *= 1 - k * k;
  }
  const g2 = P.rms * P.rms * norm, scale = P.lag ? 4 / P.lag : r.R * W.ws2 / (W.ws / 2) ** 2, rate = r.codec.rate;
  const at = hz => {
    const w = 2 * Math.PI * hz / rate;
    let ar = 1, ai = 0;
    for (let j = 1; j <= M; j++) { ar -= a[j] * Math.cos(w * j); ai += a[j] * Math.sin(w * j); }
    const dr = 1 - LPC.preEmph * Math.cos(w), di = LPC.preEmph * Math.sin(w); // de-emphasis 1/(1 − 0.9375 z⁻¹)
    return dB(scale * g2 / ((ar * ar + ai * ai) * (dr * dr + di * di)));
  };
  return { at, frame: f, lag: P.lag, rate };
}
function drawWindow() {
  const { c, w, h } = prep($("spectrum")); c.clearRect(0, 0, w, h);
  if (!S.res) return;
  const W = windowSpectra(), col = colors(), P = LIN.pad, pw = w - P.l - P.r, ph = h - P.t - P.b, binHz = S.sr / W.N;
  const fx = f => P.l + f / LIN.fmax * pw;
  const dy = v => P.t + (LIN.dbMax - clamp(v, LIN.dbMin, LIN.dbMax)) / (LIN.dbMax - LIN.dbMin) * ph;
  c.font = "11px system-ui, sans-serif"; c.lineWidth = 1;
  for (let v = LIN.dbMin; v <= LIN.dbMax; v += 20) {
    const y = Math.round(dy(v)) + 0.5;
    c.strokeStyle = col.grid; c.beginPath(); c.moveTo(P.l, y); c.lineTo(w - P.r, y); c.stroke();
    c.fillStyle = col.muted; c.textAlign = "right"; c.fillText(v, P.l - 6, y + 4);
  }
  for (let f = 0; f <= LIN.fmax; f += 1000) {
    const x = Math.round(fx(f)) + 0.5;
    c.strokeStyle = col.grid; c.beginPath(); c.moveTo(x, P.t); c.lineTo(x, h - P.b); c.stroke();
    c.fillStyle = col.muted; c.textAlign = "center"; c.fillText(f ? f / 1000 + "k" : "0", x, h - 7);
  }
  c.save(); c.translate(11, P.t + ph / 2); c.rotate(-Math.PI / 2); c.textAlign = "center"; c.fillText("dBFS", 0, 0); c.restore();
  const trace = (spec, color, lw) => { // max of bins per pixel column
    c.strokeStyle = color; c.lineWidth = lw; c.lineJoin = "round"; c.beginPath();
    for (let px = 0; px <= pw; px++) {
      const ka = Math.floor(px / pw * LIN.fmax / binHz), kb = Math.max(ka, Math.floor((px + 1) / pw * LIN.fmax / binHz));
      let v = -Infinity; for (let k = ka; k <= Math.min(kb, spec.length - 1); k++) if (spec[k] > v) v = spec[k];
      px ? c.lineTo(P.l + px, dy(v)) : c.moveTo(P.l, dy(v));
    }
    c.stroke();
  };
  c.save(); c.beginPath(); c.rect(P.l, P.t, pw, ph); c.clip();
  trace(W.orig, col.orig, 2.5);
  trace(W.deg, col.deg, 1.4);
  c.globalAlpha = S.res.waveform === false ? 0.3 : 1; trace(W.err, col.err, 1.1); c.globalAlpha = 1;
  const env = lpcEnvelope(W);
  if (env) {
    c.strokeStyle = col.text; c.lineWidth = 1.5; c.setLineDash([5, 3]); c.beginPath();
    for (let px = 0; px <= pw; px++) {
      const f = px / pw * LIN.fmax;
      if (f > env.rate / 2) break;
      px ? c.lineTo(P.l + px, dy(env.at(f))) : c.moveTo(P.l, dy(env.at(f)));
    }
    c.stroke(); c.setLineDash([]);
    c.fillStyle = col.text; c.textAlign = "right";
    c.fillText(`- - LPC envelope, frame ${env.frame}: ${env.lag ? `voiced, ${(env.rate / env.lag).toFixed(0)} Hz pitch` : "unvoiced"}`, w - P.r - 6, P.t + 14);
  }
  const hv = S.specHover;
  if (hv && hv.x >= P.l && hv.x <= P.l + pw) {
    c.strokeStyle = col.muted; c.setLineDash([3, 3]);
    c.beginPath(); c.moveTo(hv.x + 0.5, P.t); c.lineTo(hv.x + 0.5, h - P.b); c.stroke(); c.setLineDash([]);
    const f = (hv.x - P.l) / pw * LIN.fmax, k = Math.round(f / binHz), v = a => a[k].toFixed(0);
    $("specReadout").textContent = `${fmtHz(f)}  clean ${v(W.orig)}  heard ${v(W.deg)}  error ${v(W.err)} dBFS`;
  } else $("specReadout").textContent = "";
  c.restore();
}

// ---- waterfall: live, frequency across and time scrolling down; original left, decoded right.
// While playing, each new row is what was just heard, so earlier rows keep the settings they were played with.
// When paused, the whole history is redrawn from the current settings, ending at the playhead.
const WF = { fmax: 8000, n: 1024, rowSamples: 480, dbMin: -100, strip: 40, gap: 12, pad: { l: 36, r: 40, t: 7, b: 16 } };
const WF_HANN = (() => { const w = new Float64Array(WF.n); for (let i = 0; i < WF.n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / WF.n); return w; })();
const WF_REF = (() => { let s = 0; for (const v of WF_HANN) s += v; return (s / 2) ** 2; })(); // a sine of amplitude A reads A²
// viridis, −100 dBFS (dark purple) to 0 dBFS (yellow)
const WF_LUT = (() => {
  const stops = ["440154", "472d7b", "3b528b", "2c728e", "21918c", "28ae80", "5ec962", "addc30", "fde725"].map(h => h.match(/\w\w/g).map(v => parseInt(v, 16)));
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const u = i / 255 * (stops.length - 1), j = Math.min(stops.length - 2, Math.floor(u)), f = u - j;
    for (let ch = 0; ch < 3; ch++) lut[i * 3 + ch] = Math.round(stops[j][ch] * (1 - f) + stops[j + 1][ch] * f);
  }
  return lut;
})();
const WF_LOST = [217, 69, 43];
function wfLayout(w, h) {
  const P = WF.pad, halfW = Math.max(10, Math.floor((w - P.l - P.r - WF.gap) / 2)), wfTop = P.t + WF.strip + 4;
  return { P, halfW, x0: [P.l, P.l + halfW + WF.gap], wfTop, wfH: Math.max(10, Math.floor(h - wfTop - P.b)) };
}
// spectra of the original and decoded sound around sample t, wrapping as playback loops
const wfRe = new Float64Array(WF.n), wfIm = new Float64Array(WF.n);
function wfRow(t) {
  const n = S.x.length, r = S.res, binHz = S.sr / WF.n, NB = Math.floor(WF.fmax / binHz) + 2;
  t = ((Math.round(t) % n) + n) % n;
  const spec = a => {
    for (let i = 0; i < WF.n; i++) { wfRe[i] = a[(t - WF.n / 2 + i + n) % n] * WF_HANN[i]; wfIm[i] = 0; }
    fft(wfRe, wfIm);
    const out = new Float32Array(NB);
    for (let k = 0; k < NB; k++) out[k] = dB((wfRe[k] * wfRe[k] + wfIm[k] * wfIm[k]) / WF_REF + 1e-30);
    return out;
  };
  return { t, o: spec(S.x), d: spec(r.out), lost: !!(r.lost && r.lost[Math.floor(t / r.F48)]), binHz };
}
function wfPaint(rows, y0, L, ctx) { // paint rows into the offscreen image from row y0 down
  const W = 2 * L.halfW + WF.gap, img = ctx.createImageData(W, rows.length), d = img.data;
  rows.forEach((row, y) => {
    [row.o, row.d].forEach((sp, half) => {
      const xs = half * (L.halfW + WF.gap);
      for (let x = 0; x < L.halfW; x++) {
        const q = ((y * W) + xs + x) * 4;
        let rgb;
        if (half && row.lost && x < 5) rgb = WF_LOST;     // lost frame: a red mark on the decoded side
        else {
          const kf = (x + 0.5) / L.halfW * WF.fmax / row.binHz, k0 = Math.floor(kf), fr = kf - k0;
          const v = sp[k0] * (1 - fr) + sp[k0 + 1] * fr, i = clamp(Math.round((v - WF.dbMin) / -WF.dbMin * 255), 0, 255) * 3;
          rgb = [WF_LUT[i], WF_LUT[i + 1], WF_LUT[i + 2]];
        }
        d[q] = rgb[0]; d[q + 1] = rgb[1]; d[q + 2] = rgb[2]; d[q + 3] = 255;
      }
    });
  });
  ctx.putImageData(img, 0, y0);
}
function wfRebuild(L) {
  const off = document.createElement("canvas"); off.width = 2 * L.halfW + WF.gap; off.height = L.wfH;
  const p = playPos() * S.sr, rows = [];
  for (let k = 0; k < L.wfH; k++) rows.push(wfRow(p - k * WF.rowSamples));
  wfPaint(rows, 0, L, off.getContext("2d"));
  S.wf = { L, x: S.x, off, rows, pos: rows[0].t, pausedKey: null };
}
function wfAdvance() { // add the rows played since the last frame
  const W = S.wf, n = S.x.length, p = Math.round(playPos() * S.sr);
  const k = Math.floor((((p - W.pos) % n) + n) % n / WF.rowSamples);
  if (!k) return;
  if (k >= W.L.wfH) return wfRebuild(W.L); // fell far behind (e.g. a hidden tab): start afresh
  const fresh = [];
  for (let j = k; j >= 1; j--) fresh.push(wfRow(W.pos + j * WF.rowSamples));
  W.pos = fresh[0].t;
  const ctx = W.off.getContext("2d"), tmp = document.createElement("canvas");
  tmp.width = W.off.width; tmp.height = W.off.height;
  tmp.getContext("2d").drawImage(W.off, 0, 0);
  ctx.drawImage(tmp, 0, k);
  wfPaint(fresh, 0, W.L, ctx);
  W.rows = fresh.concat(W.rows).slice(0, W.L.wfH);
}
function drawWaterfall() {
  const { c, w, h } = prep($("spectrum")); c.clearRect(0, 0, w, h);
  if (!S.res) return;
  const L = wfLayout(w, h), col = colors(), playing = !!S.play.node;
  const fits = S.wf && S.wf.x === S.x && S.wf.L.halfW === L.halfW && S.wf.L.wfH === L.wfH;
  if (playing) { // append what was just heard
    if (fits) wfAdvance(); else wfRebuild(L);
    S.wf.pausedKey = null;
  } else { // paused: the whole history from the current settings, ending at the playhead
    const key = S.res.id + "|" + Math.round(playPos() * S.sr);
    if (!fits || S.wf.pausedKey !== key) { wfRebuild(L); S.wf.pausedKey = key; }
  }
  const W = S.wf, P = L.P, now = W.rows[0];
  c.imageSmoothingEnabled = false;
  c.drawImage(W.off, L.x0[0], L.wfTop, 2 * L.halfW + WF.gap, L.wfH);
  c.clearRect(L.x0[0] + L.halfW, L.wfTop, WF.gap, L.wfH);
  c.font = "11px system-ui, sans-serif"; c.lineWidth = 1;
  const fx = (half, f) => L.x0[half] + f / WF.fmax * L.halfW;
  // live spectrum strips: the row at the playhead
  const sy = v => P.t + (clamp(v, WF.dbMin, 0) / WF.dbMin) * WF.strip;
  const line = (sp, half, color, lw) => {
    c.strokeStyle = color; c.lineWidth = lw; c.beginPath();
    for (let x = 0; x <= L.halfW; x++) {
      const kf = x / L.halfW * WF.fmax / now.binHz, k0 = Math.min(sp.length - 2, Math.floor(kf)), fr = kf - k0;
      const y = sy(sp[k0] * (1 - fr) + sp[k0 + 1] * fr);
      x ? c.lineTo(L.x0[half] + x, y) : c.moveTo(L.x0[half], y);
    }
    c.stroke();
  };
  for (const half of [0, 1]) {
    c.strokeStyle = col.grid;
    c.beginPath(); for (const v of [0, -50, -100]) { const y = Math.round(sy(v)) + 0.5; c.moveTo(L.x0[half], y); c.lineTo(L.x0[half] + L.halfW, y); } c.stroke();
    for (let f = 0; f <= WF.fmax; f += 2000) {
      c.fillStyle = col.muted; c.textAlign = f ? (f === WF.fmax ? "right" : "center") : "left";
      c.fillText(f ? f / 1000 + "k" : "0", fx(half, f), h - 4);
    }
  }
  line(now.o, 0, col.orig, 1.4);
  line(now.o, 1, col.orig, 1);
  line(now.d, 1, col.deg, 1.4);
  c.fillStyle = col.text; c.textAlign = "right";
  c.fillText("Original", L.x0[0] + L.halfW - 4, P.t + 11); c.fillText("Decoded", L.x0[1] + L.halfW - 4, P.t + 11);
  c.fillStyle = col.muted; c.textAlign = "right";
  for (const v of [0, -50, -100]) c.fillText(v, P.l - 5, sy(v) + 4);
  // time down the left: 100 rows per second
  for (let k = 0; k * 100 < L.wfH; k++) c.fillText(k ? `−${k} s` : (playing ? "now" : "here"), P.l - 5, L.wfTop + k * 100 + 10);
  // the codec's cutoff on the decoded side
  if (!S.res.off) {
    const x = Math.round(fx(1, S.res.cutoff)) + 0.5;
    c.strokeStyle = "rgba(255,255,255,0.8)"; c.setLineDash([4, 4]);
    c.beginPath(); c.moveTo(x, L.wfTop); c.lineTo(x, L.wfTop + L.wfH); c.stroke(); c.setLineDash([]);
  }
  // colour scale
  const bx = w - P.r + 8, grad = c.createLinearGradient(0, L.wfTop, 0, L.wfTop + L.wfH);
  for (let i = 0; i <= 8; i++) { const j = Math.round((1 - i / 8) * 255) * 3; grad.addColorStop(i / 8, `rgb(${WF_LUT[j]},${WF_LUT[j + 1]},${WF_LUT[j + 2]})`); }
  c.fillStyle = grad; c.fillRect(bx, L.wfTop, 8, L.wfH);
  c.fillStyle = col.muted; c.textAlign = "left";
  c.fillText("0", bx + 11, L.wfTop + 9); c.fillText("−50", bx + 11, L.wfTop + L.wfH / 2 + 4); c.fillText("−100", bx + 11, L.wfTop + L.wfH);
  // hover: the same frequency on both sides
  const hv = S.specHover;
  const half = hv ? (hv.x >= L.x0[1] ? 1 : 0) : 0, xin = hv ? hv.x - L.x0[half] : -1;
  if (hv && xin >= 0 && xin < L.halfW && hv.y >= P.t && hv.y < L.wfTop + L.wfH) {
    const f = xin / L.halfW * WF.fmax, row = hv.y >= L.wfTop ? W.rows[clamp(Math.floor(hv.y - L.wfTop), 0, W.rows.length - 1)] : now;
    const k = Math.round(f / row.binHz);
    c.strokeStyle = "rgba(255,255,255,0.9)"; c.setLineDash([3, 3]); c.beginPath();
    for (const hh of [0, 1]) { const x = Math.round(fx(hh, f)) + 0.5; c.moveTo(x, P.t); c.lineTo(x, L.wfTop + L.wfH); }
    c.stroke(); c.setLineDash([]);
    $("specReadout").textContent = `${(row.t / S.sr).toFixed(2)} s  ${fmtHz(f)}  original ${row.o[k].toFixed(0)}  decoded ${row.d[k].toFixed(0)} dBFS`;
  } else $("specReadout").textContent = "";
}
function wfPick(e) { // click a row to move the zoom window to that moment
  if (specMode !== "wf" || !S.wf) return;
  const r = $("spectrum").getBoundingClientRect(), y = e.clientY - r.top - S.wf.L.wfTop;
  if (y < 0 || y >= S.wf.rows.length) return;
  S.zoomCenter = S.wf.rows[Math.floor(y)].t;
  zoomChanged();
}
let zReq;
function zoomChanged() {
  cancelAnimationFrame(zReq);
  zReq = requestAnimationFrame(() => { drawOverview(); drawZoom(); if (specMode === "win") drawSpectrum(); });
}

function drawAll() { S.overviewCache = null; drawOverview(); drawZoom(); drawSpectrum(); }

// ---------- controls ----------
function seg(id, initial, onChange) {
  const root = $(id);
  const api = {
    value: initial,
    set(v, silent) {
      api.value = v;
      root.querySelectorAll("button[data-v]").forEach(b => b.classList.toggle("on", b.dataset.v === String(v)));
      if (!silent && onChange) onChange(v);
    },
  };
  root.addEventListener("click", e => {
    const b = e.target.closest("button[data-v]");
    if (b) api.set(b.dataset.v);
  });
  api.set(initial, true);
  return api;
}

const fmtCount = v => v >= 1e6 ? (v / 1e6).toFixed(2) + " M" : v >= 1e4 ? (v / 1e3).toFixed(0) + " k" : String(v);
function updateReadouts() {
  const r = S.res, set = (id, t) => { $(id).textContent = t; };
  if (r.off) {
    for (const id of ["tRate", "tLost", "tBer", "tSnr", "tSd", "tSeg"]) set(id, "–");
    set("tNote", r.note);
    return;
  }
  set("tRate", `${r.rate % 1000 ? (r.rate / 1000).toFixed(1) : r.rate / 1000} kbit/s`);
  set("tLost", r.st.lossOn ? `${r.nLost} of ${r.nf} · ${(100 * r.nLost / r.nf).toFixed(1)}%` : "–");
  set("tBer", r.st.berOn ? `${fmtCount(r.nErr)} of ${fmtCount(r.nBits)}` : "–");
  set("tSnr", r.waveform ? fmtDb(r.snr) : "n/a");
  set("tSd", isFinite(r.sd) ? r.sd.toFixed(1) + " dB" : "–");
  set("tSeg", r.waveform ? (r.seg >= 35 ? "≥ 35 dB" : fmtDb(r.seg)) : "n/a");
  set("tNote", r.note + (r.waveform ? "" : " · a new waveform, so no SNR"));
}

let pending = false;
function schedule() {
  updateLabels();
  if (pending) return;
  pending = true;
  setTimeout(() => { pending = false; processAudio(); }, 15);
}
function updateLabels() {
  const on = $("codecOn").checked;
  $("codecCtl").classList.toggle("off", !on);
  $("lossCtl").classList.toggle("off", !on || !$("lossOn").checked);
  $("berCtl").classList.toggle("off", !on || !$("berOn").checked);
}
function manual() { $("preset").value = ""; $("presetNote").textContent = ""; }

// codec setting: the slider steps through the codec's allowed values
const values = () => CODECS[$("codec").value].values;
const nearest = (vals, v) => { let b = 0; vals.forEach((u, i) => { if (Math.abs(u - v) < Math.abs(vals[b] - v)) b = i; }); return b; };
function setupCodec(value) {
  const c = CODECS[$("codec").value], vals = c.values;
  $("codecCtl").classList.toggle("fixed", !vals);
  if (!vals) { $("paramUnit").textContent = c.fixed; $("paramNum").value = ""; return; }
  $("param").max = vals.length - 1;
  $("paramUnit").textContent = c.unit;
  $("endL").textContent = `${vals[0]} ${c.unit}`;
  setVal("param", value ?? c.def);
}
// the number box holds the value; the slider follows it
const fmtBer = v => v.toExponential(1);
const NUM = {
  param: { toSlider: v => nearest(values(), v), fromSlider: i => values()[i], valid: v => values().includes(v),
           tidy: v => values()[nearest(values(), v)], fmt: v => v, on: ["codecOn"] },
  loss:  { toSlider: v => v, fromSlider: v => v, valid: v => v >= 0 && v <= 50,
           tidy: v => clamp(v, 0, 50), fmt: v => v, on: ["codecOn", "lossOn"] },
  ber:   { toSlider: v => Math.log10(v), fromSlider: s => +Math.pow(10, s).toPrecision(2), valid: v => v >= 1e-7 && v <= 0.5,
           tidy: v => clamp(v, 1e-7, 0.5), fmt: fmtBer, on: ["codecOn", "berOn"] },
};
function setVal(id, v) { $(id + "Num").value = NUM[id].fmt(v); $(id).value = NUM[id].toSlider(v); }
for (const [id, d] of Object.entries(NUM)) {
  const num = $(id + "Num"), rng = $(id);
  const changed = () => { for (const k of d.on) $(k).checked = true; manual(); schedule(); };
  rng.addEventListener("input", () => { num.value = d.fmt(d.fromSlider(+rng.value)); changed(); });
  num.addEventListener("input", () => {
    const v = parseFloat(num.value);
    if (!isFinite(v) || !d.valid(v)) return; // wait until the typed value is sensible
    rng.value = d.toSlider(v); changed();
  });
  num.addEventListener("change", () => { // on enter/blur, tidy anything invalid back to a valid value
    const v = parseFloat(num.value), t = isFinite(v) ? d.tidy(v) : d.fromSlider(+rng.value);
    setVal(id, t); changed();
  });
}
// picking an option also switches its control on
$("codec").addEventListener("change", () => { $("codecOn").checked = true; setupCodec(); manual(); schedule(); });
$("conceal").addEventListener("change", () => { $("codecOn").checked = $("lossOn").checked = true; manual(); schedule(); });
$("burst").addEventListener("change", () => { $("codecOn").checked = $("lossOn").checked = true; manual(); schedule(); });
for (const id of ["codecOn", "lossOn", "berOn"]) $(id).addEventListener("change", () => {
  if (id !== "codecOn" && $(id).checked) $("codecOn").checked = true;
  manual(); schedule();
});
const zoomSeg = seg("zoomSeg", "0.02", v => { S.zoomLen = +v; zoomChanged(); });
const specSeg = seg("specSeg", specMode, v => { specMode = v; S.specHover = null; $("specReadout").textContent = ""; drawSpectrum(); });
$("detailOn").addEventListener("change", () => { drawZoom(); drawSpectrum(); });
$("playBtn").addEventListener("click", play);
$("pauseBtn").addEventListener("click", pause);
$("stopBtn").addEventListener("click", stop);
document.addEventListener("keydown", e => { // space toggles play/pause
  if (e.code !== "Space" || e.target.closest("input, select, textarea, dialog")) return;
  e.preventDefault();
  S.play.node ? pause() : play();
});
$("aboutBtn").addEventListener("click", () => $("about").showModal());
$("about").addEventListener("click", e => { if (e.target === $("about")) $("about").close(); }); // click backdrop to close

// unset fields keep their current value; loss/ber only matter when switched on
const PRESETS = [
  { group: "Comparisons" },
  { id: "clean", name: "Clean (no codec)", codecOn: false, lossOn: false, berOn: false },
  { id: "band", name: "Telephone band only", codec: "pcm8", param: 16, lossOn: false, berOn: false,
    note: "8 kHz sampling at 16 bits: only what's above 3.4 kHz is lost." },
  { id: "lin8", name: "8-bit linear (64 kbit/s)", codec: "pcm8", param: 8, lossOn: false, berOn: false,
    note: "Same 64 kbit/s as G.711, but quiet sounds get coarse steps too." },
  { id: "lin4", name: "4-bit linear (32 kbit/s)", codec: "pcm8", param: 4, lossOn: false, berOn: false,
    note: "Same bit rate as DECT's 4-bit ADPCM. Compare with the DECT preset." },
  { id: "wide", name: "Wideband (16 kHz, 16-bit)", codec: "pcm16", param: 16, lossOn: false, berOn: false,
    note: "“HD voice” bandwidth: up to about 7 kHz instead of 3.4 kHz." },
  { group: "Telephone" },
  { id: "pstn-u", name: "PSTN μ-law (G.711)", codec: "ulaw", lossOn: false, berOn: false,
    note: "ITU-T G.711 μ-law: the North American and Japanese phone network." },
  { id: "pstn-a", name: "PSTN A-law (G.711)", codec: "alaw", lossOn: false, berOn: false,
    note: "ITU-T G.711 A-law: Europe and most international links." },
  { id: "dect", name: "DECT (G.726, 32 kbit/s)", codec: "g726", param: 32, lossOn: false, berOn: false,
    note: "DECT cordless phones use G.726 at 32 kbit/s (ETSI EN 300 175-8)." },
  { id: "g726-40", name: "G.726 at 40 kbit/s", codec: "g726", param: 40, lossOn: false, berOn: false,
    note: "G.726's 5-bit rate, intended mainly for carrying modem signals." },
  { id: "g726-16", name: "G.726 at 16 kbit/s", codec: "g726", param: 16, lossOn: false, berOn: false,
    note: "G.726's lowest rate, 2 bits per sample: intelligible but rough." },
  { id: "ima", name: "IMA ADPCM", codec: "ima", lossOn: false, berOn: false,
    note: "4 bits per sample plus a state header per packet. Used in WAV files and games." },
  { group: "Vocoders" },
  { id: "lpc24", name: "LPC-10 (2400 bit/s)", codec: "lpc", param: 2400, lossOn: false, berOn: false,
    note: "FS-1015 / STANAG 4198: military HF and early secure phones." },
  { id: "lpc12", name: "LPC at 1200 bit/s", codec: "lpc", param: 1200, lossOn: false, berOn: false,
    note: "The same 54-bit frame, sent every 45 ms. Speech starts to slur." },
  { id: "lpc6", name: "LPC at 600 bit/s", codec: "lpc", param: 600, lossOn: false, berOn: false,
    note: "90 ms frames. Real 600 bit/s coders (MELPe, STANAG 4591) are far smarter." },
  { group: "Packet loss (VoIP, G.711)" },
  { id: "voip1s", name: "1% loss, silence", codec: "ulaw", lossOn: true, loss: 1, burst: false, conceal: "silence", berOn: false,
    note: "Light loss with gaps left silent: occasional dropouts." },
  { id: "voip5s", name: "5% loss, silence", codec: "ulaw", lossOn: true, loss: 5, burst: false, conceal: "silence", berOn: false,
    note: "A poor network link. The gaps are hard to ignore." },
  { id: "voip5r", name: "5% loss, repeat", codec: "ulaw", lossOn: true, loss: 5, burst: false, conceal: "repeat", berOn: false,
    note: "The same losses, filled by repeating the last packet." },
  { id: "voip10r", name: "10% loss, repeat", codec: "ulaw", lossOn: true, loss: 10, burst: false, conceal: "repeat", berOn: false,
    note: "Heavy loss: concealment can only do so much." },
  { id: "voip5b", name: "5% loss in bursts, fading", codec: "ulaw", lossOn: true, loss: 5, burst: true, conceal: "fade", berOn: false,
    note: "Same average loss in runs of about 3 packets: fewer, longer gaps." },
  { group: "Bit errors (radio links)" },
  { id: "ber-g711", name: "G.711 at BER 10⁻³", codec: "ulaw", lossOn: false, berOn: true, ber: 1e-3,
    note: "Errors in sign or segment bits are loud clicks; mantissa errors are small." },
  { id: "ber-g726", name: "G.726 at BER 10⁻³", codec: "g726", param: 32, lossOn: false, berOn: true, ber: 1e-3,
    note: "Each error knocks the decoder's predictor and step size off; they drift back." },
  { id: "ber-ima", name: "IMA at BER 10⁻³", codec: "ima", lossOn: false, berOn: true, ber: 1e-3,
    note: "Errors spread until the next packet header resets the decoder." },
  { id: "ber-lpc", name: "LPC-10 at BER 10⁻²", codec: "lpc", param: 2400, lossOn: false, berOn: true, ber: 1e-2,
    note: "One error spoils a whole frame's pitch, gain or filter: warbles and pops." },
];
{
  const sel = $("preset");
  sel.add(new Option("—", ""));
  let parent = sel;
  for (const p of PRESETS) {
    if (p.group) { parent = document.createElement("optgroup"); parent.label = p.group; sel.append(parent); continue; }
    parent.append(new Option(p.name, p.id));
  }
}
$("preset").addEventListener("change", e => {
  const p = PRESETS.find(q => q.id === e.target.value); if (!p) return;
  $("codecOn").checked = p.codecOn !== false;
  if (p.codec) { $("codec").value = p.codec; setupCodec(p.param); }
  if (p.lossOn != null) $("lossOn").checked = p.lossOn;
  if (p.loss != null) setVal("loss", p.loss);
  if (p.burst != null) $("burst").checked = p.burst;
  if (p.conceal) $("conceal").value = p.conceal;
  if (p.berOn != null) $("berOn").checked = p.berOn;
  if (p.ber != null) setVal("ber", p.ber);
  $("presetNote").textContent = p.note || "";
  schedule();
});

// overview: click / drag to move the zoom window
function overviewPick(e) {
  if (!S.x) return;
  const r = $("overview").getBoundingClientRect();
  S.zoomCenter = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * S.x.length;
  zoomChanged();
}
$("overview").addEventListener("pointerdown", e => { $("overview").setPointerCapture(e.pointerId); overviewPick(e); });
$("overview").addEventListener("pointermove", e => { if (e.buttons) overviewPick(e); });
$("spectrum").addEventListener("mousemove", onSpecHover);
$("spectrum").addEventListener("pointerdown", wfPick);
$("spectrum").addEventListener("mouseleave", () => { S.specHover = null; $("specReadout").textContent = ""; drawSpectrum(); });
let rsz; window.addEventListener("resize", () => { clearTimeout(rsz); rsz = setTimeout(drawAll, 100); });

// ---------- sources ----------
function selectSource(name) {
  const x = S.sources[name]; if (!x) return;
  const wasPlaying = !!S.play.node;
  stop();
  S.srcName = name; S.x = x; S.peak = peakOf(x);
  // start the zoom on the loudest moment
  let im = 0; for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > Math.abs(x[im])) im = i;
  S.zoomCenter = name === "tone" ? x.length / 2 : im;
  $("src").value = name;
  processAudio();
  if (wasPlaying) play();
}
$("src").addEventListener("change", e => selectSource(e.target.value));
$("fileBtn").addEventListener("click", () => $("fileIn").click());
$("fileIn").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  $("srcStatus").textContent = "Decoding…";
  try {
    S.sources.file = await decode(await f.arrayBuffer());
    const opt = $("src").querySelector('option[value="file"]');
    opt.hidden = false; opt.disabled = false; opt.textContent = f.name;
    $("srcStatus").textContent = "";
    selectSource("file");
  } catch (err) {
    $("srcStatus").textContent = `Couldn't decode ${f.name}.`;
  }
  e.target.value = "";
});

(async function init() {
  audioCtx();
  $("codec").value = "ulaw"; setupCodec();
  setVal("loss", 5); setVal("ber", 1e-3);
  updateLabels();
  S.sources.tone = makeTone();
  for (const name of ["voice", "voice-woman", "voice-deep", "music"]) {
    const opt = $("src").querySelector(`option[value="${name}"]`);
    const got = await fetchBundled(name);
    if (got) { try { S.sources[name] = await decode(got.data); continue; } catch (_) {} }
    opt.disabled = true; opt.textContent += " (missing)";
  }
  if (location.protocol === "file:" && (!S.sources.voice || !S.sources.music))
    $("srcStatus").textContent = "Serve over HTTP to load the bundled clips.";
  selectSource(S.sources.voice ? "voice" : S.sources.music ? "music" : "tone");
})();
