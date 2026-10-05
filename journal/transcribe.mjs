// journal/transcribe.mjs — speech to text, on the box.
//
// Two binaries and no network: ffmpeg (the static build the `ffmpeg-static`
// package ships) turns whatever the phone recorded — Safari's audio/mp4, Chrome's
// audio/webm — into the 16 kHz mono WAV whisper wants, and whisper.cpp's
// `whisper-cli` (built by scripts/install-whisper.sh) turns that into text with
// per-segment timestamps. A speech API key would have been ten lines shorter and
// would have expired silently one morning in March; the recording is also the
// most private thing this system handles, and it never needs to leave the machine.
//
// `status()` says whether both halves are in place so the Journal view can show
// "transcription isn't installed" instead of a recording that fails five seconds
// after save. Nothing here deletes the audio — that's the service's decision, made
// only once the transcript has been written down.
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'

const WAV_RATE = 16_000
const WAV_BYTES_PER_SAMPLE = 2

const exists = (path) => access(path).then(() => true, () => false)

function run(bin, args, { timeout, cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, cwd, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || '').trim().split('\n').slice(-6).join('\n')
        const why = err.killed ? `timed out after ${timeout}ms` : (detail || err.message)
        return reject(new Error(why))
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

/** Seconds of audio in a 16 kHz mono PCM16 WAV, from its size alone. */
export function wavDurationSeconds(bytes, { headerBytes = 44 } = {}) {
  const data = Math.max(0, Number(bytes) - headerBytes)
  return Math.round((data / (WAV_RATE * WAV_BYTES_PER_SAMPLE)) * 10) / 10
}

/**
 * Turn whisper-cli's `-oj` file into the shape the entry stores.
 *
 * Segments keep their offsets in seconds so the UI can show "at 3:12" beside a
 * sentence later; the joined text is what the ingest reads. whisper leaves a
 * leading space on every segment and sometimes emits bracketed noise markers —
 * both are stripped, and an empty result is an error rather than a blank entry,
 * because a blank journal that "succeeded" would be ingested as nothing said.
 */
export function parseWhisperJson(raw) {
  let doc
  try { doc = typeof raw === 'string' ? JSON.parse(raw) : raw }
  catch { throw new Error('whisper produced unreadable JSON') }
  const segments = []
  for (const seg of doc?.transcription || []) {
    const text = cleanSegment(seg?.text)
    if (!text) continue
    segments.push({
      start: Math.max(0, Number(seg?.offsets?.from ?? 0) / 1000),
      end: Math.max(0, Number(seg?.offsets?.to ?? 0) / 1000),
      text,
    })
  }
  const text = segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim()
  if (!text) throw new Error('no speech was recognised in the recording')
  return { text, segments, language: doc?.result?.language || doc?.params?.language || null, model: doc?.model?.type || null }
}

function cleanSegment(value) {
  return String(value ?? '')
    // whisper's markers for non-speech: [BLANK_AUDIO], (music), [inaudible] …
    .replace(/\[(?:BLANK_AUDIO|inaudible|music|silence|noise)[^\]]*\]/gi, ' ')
    .replace(/\((?:music|silence|applause|laughter)[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function createTranscriber({
  whisperBin,
  modelFile,
  ffmpegBin,
  threads = Math.max(1, Math.min(8, cpus().length - 1)),
  language = 'en',
  // A ten-minute entry on a 6-core CPU with small.en is a few minutes; anything
  // past this is a hung process, not a long journal.
  timeoutMs = 30 * 60_000,
  log = () => {},
  runImpl = run,
} = {}) {
  async function status() {
    const [bin, model, ffmpeg] = await Promise.all([
      whisperBin ? exists(whisperBin) : false,
      modelFile ? exists(modelFile) : false,
      ffmpegBin ? exists(ffmpegBin) : false,
    ])
    const missing = []
    if (!bin) missing.push(`whisper-cli (${whisperBin || 'unset'})`)
    if (!model) missing.push(`model (${modelFile || 'unset'})`)
    if (!ffmpeg) missing.push(`ffmpeg (${ffmpegBin || 'unset'})`)
    return {
      ready: missing.length === 0,
      missing,
      fix: missing.length ? 'Run scripts/install-whisper.sh, then set JOURNAL_WHISPER_BIN / JOURNAL_WHISPER_MODEL if you chose a different location.' : null,
      whisperBin: whisperBin || null,
      modelFile: modelFile || null,
      model: modelFile ? modelFile.replace(/^.*ggml-/, '').replace(/\.bin$/, '') : null,
      ffmpegBin: ffmpegBin || null,
      threads,
    }
  }

  /**
   * Transcribe one audio file. Returns `{ text, segments, language, model,
   * durationSec, ms }`. The WAV and JSON intermediates live in a temp dir that is
   * removed whatever happens; the input file is left exactly where it was.
   */
  async function transcribe({ audioFile, prompt = '' }) {
    const s = await status()
    if (!s.ready) throw new Error(`transcription is not installed: missing ${s.missing.join(', ')}`)
    const startedAt = Date.now()
    const work = await mkdtemp(join(tmpdir(), 'totem-journal-'))
    try {
      const wav = join(work, 'audio.wav')
      // -vn: ignore any video track a phone may have wrapped around the audio.
      // -af: gentle normalisation so a quiet bedroom recording is still heard.
      await runImpl(ffmpegBin, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', audioFile, '-vn', '-ac', '1', '-ar', String(WAV_RATE),
        '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'pcm_s16le', wav,
      ], { timeout: 5 * 60_000 })
      const durationSec = wavDurationSeconds((await stat(wav)).size)
      if (durationSec < 0.5) throw new Error('the recording is empty')

      const outBase = join(work, 'out')
      const args = [
        '-m', modelFile, '-f', wav, '-oj', '-of', outBase,
        '-t', String(threads), '-l', language, '-np', '-nt',
      ]
      const hint = String(prompt || '').trim()
      if (hint) args.push('--prompt', hint)
      await runImpl(whisperBin, args, { timeout: timeoutMs })
      const parsed = parseWhisperJson(await readFile(`${outBase}.json`, 'utf8'))
      const ms = Date.now() - startedAt
      log(`journal: transcribed ${durationSec}s of audio in ${ms}ms (${parsed.segments.length} segments)`)
      return { ...parsed, durationSec, ms }
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {})
    }
  }

  return { status, transcribe }
}
