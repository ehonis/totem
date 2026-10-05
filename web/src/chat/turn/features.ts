// Whisper's log-mel front end, as Smart Turn v3 was trained on it.
//
// A port of transformers' WhisperFeatureExtractor exactly as pipecat-ai/smart-turn
// calls it (inference.py): the last 8 s of 16 kHz audio, zero-padded at the
// *front*, normalised to zero mean / unit variance over the whole 8 s, then an
// 80-bin Slaney mel spectrogram of a 400-point periodic-Hann STFT (hop 160,
// centred with reflect padding), log10, clamped to 8 below the max, and scaled
// (x + 4) / 4. The last STFT frame is dropped, leaving 800 frames.
//
// Checked against the Python reference on real speech (features.test.ts): any
// drift here shows up as a confidently wrong "you're done talking".

export const SAMPLE_RATE = 16000
export const N_SAMPLES = 8 * SAMPLE_RATE
const N_FFT = 400
const HOP = 160
const N_MELS = 80
const N_BINS = N_FFT / 2 + 1
const N_FRAMES = N_SAMPLES / HOP // 800

const hzToMel = (f: number) => {
  // Slaney: linear below 1 kHz, logarithmic above.
  const fMin = 0, fSp = 200 / 3, minLogHz = 1000, minLogMel = (minLogHz - fMin) / fSp, logstep = Math.log(6.4) / 27
  return f >= minLogHz ? minLogMel + Math.log(f / minLogHz) / logstep : (f - fMin) / fSp
}
const melToHz = (m: number) => {
  const fMin = 0, fSp = 200 / 3, minLogHz = 1000, minLogMel = (minLogHz - fMin) / fSp, logstep = Math.log(6.4) / 27
  return m >= minLogMel ? minLogHz * Math.exp(logstep * (m - minLogMel)) : fMin + fSp * m
}

let melBank: Float32Array[] | null = null
function filters() {
  if (melBank) return melBank
  const fftFreqs = Array.from({ length: N_BINS }, (_, i) => (i * SAMPLE_RATE) / N_FFT)
  const melMin = hzToMel(0), melMax = hzToMel(SAMPLE_RATE / 2)
  const pts = Array.from({ length: N_MELS + 2 }, (_, i) => melToHz(melMin + ((melMax - melMin) * i) / (N_MELS + 1)))
  melBank = []
  for (let m = 0; m < N_MELS; m++) {
    const row = new Float32Array(N_BINS)
    const lo = pts[m], mid = pts[m + 1], hi = pts[m + 2]
    const enorm = 2 / (hi - lo) // Slaney area normalisation
    for (let k = 0; k < N_BINS; k++) {
      const f = fftFreqs[k]
      const up = (f - lo) / (mid - lo)
      const down = (hi - f) / (hi - mid)
      row[k] = Math.max(0, Math.min(up, down)) * enorm
    }
    melBank.push(row)
  }
  return melBank
}

let cosT: Float32Array | null = null
let sinT: Float32Array | null = null
let hann: Float32Array | null = null
function tables() {
  if (cosT) return
  hann = new Float32Array(N_FFT)
  for (let i = 0; i < N_FFT; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT) // periodic
  cosT = new Float32Array(N_BINS * N_FFT)
  sinT = new Float32Array(N_BINS * N_FFT)
  for (let k = 0; k < N_BINS; k++) {
    for (let n = 0; n < N_FFT; n++) {
      const a = (2 * Math.PI * k * n) / N_FFT
      cosT[k * N_FFT + n] = Math.cos(a)
      sinT[k * N_FFT + n] = Math.sin(a)
    }
  }
}

/** The trailing 8 s, front-padded with zeros. */
export function lastEightSeconds(audio: Float32Array): Float32Array {
  if (audio.length >= N_SAMPLES) return audio.slice(audio.length - N_SAMPLES)
  const out = new Float32Array(N_SAMPLES)
  out.set(audio, N_SAMPLES - audio.length)
  return out
}

/** 16 kHz mono → Float32Array [80 × 800], row-major (mel, frame). */
export function logMel(audio16k: Float32Array): Float32Array {
  tables()
  const bank = filters()
  const x = lastEightSeconds(audio16k)
  // Zero mean, unit variance over the whole window (padding included).
  let mean = 0
  for (let i = 0; i < x.length; i++) mean += x[i]
  mean /= x.length
  let v = 0
  for (let i = 0; i < x.length; i++) v += (x[i] - mean) ** 2
  const sd = Math.sqrt(v / x.length + 1e-7)
  const y = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) y[i] = (x[i] - mean) / sd
  // Centre: reflect-pad n_fft/2 on each side.
  const pad = N_FFT / 2
  const padded = new Float32Array(y.length + 2 * pad)
  padded.set(y, pad)
  for (let i = 0; i < pad; i++) {
    padded[pad - 1 - i] = y[i + 1]
    padded[pad + y.length + i] = y[y.length - 2 - i]
  }
  const out = new Float32Array(N_MELS * N_FRAMES)
  const frame = new Float32Array(N_FFT)
  const power = new Float32Array(N_BINS)
  let maxLog = -Infinity
  for (let t = 0; t < N_FRAMES; t++) {
    const off = t * HOP
    for (let n = 0; n < N_FFT; n++) frame[n] = padded[off + n] * hann![n]
    for (let k = 0; k < N_BINS; k++) {
      let re = 0, im = 0
      const base = k * N_FFT
      for (let n = 0; n < N_FFT; n++) { re += frame[n] * cosT![base + n]; im -= frame[n] * sinT![base + n] }
      power[k] = re * re + im * im
    }
    for (let m = 0; m < N_MELS; m++) {
      const row = bank[m]
      let s = 0
      for (let k = 0; k < N_BINS; k++) s += row[k] * power[k]
      const l = Math.log10(Math.max(s, 1e-10))
      out[m * N_FRAMES + t] = l
      if (l > maxLog) maxLog = l
    }
  }
  const floor = maxLog - 8
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i], floor) + 4) / 4
  return out
}
