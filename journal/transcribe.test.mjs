import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTranscriber, parseWhisperJson, wavDurationSeconds } from './transcribe.mjs'

test('wav duration comes from the byte count of 16 kHz mono PCM16', () => {
  assert.equal(wavDurationSeconds(44 + 16_000 * 2 * 10), 10)
  assert.equal(wavDurationSeconds(44), 0)
})

test('parseWhisperJson joins segments, keeps offsets in seconds, and strips noise markers', () => {
  const doc = {
    result: { language: 'en' },
    model: { type: 'small' },
    transcription: [
      { offsets: { from: 0, to: 3000 }, text: ' [BLANK_AUDIO]' },
      { offsets: { from: 3000, to: 8000 }, text: ' Woke up at six.' },
      { offsets: { from: 8000, to: 12500 }, text: ' Went climbing (music) after work.' },
    ],
  }
  const out = parseWhisperJson(JSON.stringify(doc))
  assert.equal(out.text, 'Woke up at six. Went climbing after work.')
  assert.deepEqual(out.segments.map((s) => [s.start, s.end]), [[3, 8], [8, 12.5]])
  assert.equal(out.language, 'en')
  assert.equal(out.model, 'small')
})

test('a transcript with no words is an error, never a blank success', () => {
  assert.throws(() => parseWhisperJson({ transcription: [{ text: ' [BLANK_AUDIO]', offsets: { from: 0, to: 1 } }] }), /no speech/)
  assert.throws(() => parseWhisperJson('nope'), /unreadable/)
})

test('status names each missing piece and the fix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'journal-tx-'))
  const model = join(dir, 'ggml-small.en.bin')
  await writeFile(model, 'x')
  const t = createTranscriber({ whisperBin: join(dir, 'nope'), modelFile: model, ffmpegBin: join(dir, 'nope2') })
  const s = await t.status()
  assert.equal(s.ready, false)
  assert.equal(s.missing.length, 2)
  assert.match(s.fix, /install-whisper/)
  assert.equal(s.model, 'small.en')
  await assert.rejects(t.transcribe({ audioFile: 'a.m4a' }), /not installed/)
})

test('transcribe converts, runs whisper with the vocabulary prompt, and reads the JSON back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'journal-tx-'))
  const bins = { whisper: join(dir, 'whisper-cli'), model: join(dir, 'model.bin'), ffmpeg: join(dir, 'ffmpeg') }
  await Promise.all(Object.values(bins).map((p) => writeFile(p, '')))
  const calls = []
  const runImpl = async (bin, args) => {
    calls.push([bin, args])
    if (bin === bins.ffmpeg) {
      // 5 seconds of "audio".
      await writeFile(args[args.length - 1], Buffer.alloc(44 + 16_000 * 2 * 5))
    } else {
      const outBase = args[args.indexOf('-of') + 1]
      await writeFile(`${outBase}.json`, JSON.stringify({
        result: { language: 'en' }, model: { type: 'small' },
        transcription: [{ offsets: { from: 0, to: 5000 }, text: ' Rode to Fairview with Robin.' }],
      }))
    }
    return { stdout: '', stderr: '' }
  }
  const t = createTranscriber({ whisperBin: bins.whisper, modelFile: bins.model, ffmpegBin: bins.ffmpeg, threads: 3, runImpl })
  const out = await t.transcribe({ audioFile: join(dir, 'in.m4a'), prompt: 'Robin, Fairview' })
  assert.equal(out.text, 'Rode to Fairview with Robin.')
  assert.equal(out.durationSec, 5)
  assert.equal(calls.length, 2)
  const [ffArgs, wArgs] = [calls[0][1], calls[1][1]]
  assert.ok(ffArgs.includes('16000') && ffArgs.includes('pcm_s16le'))
  assert.equal(wArgs[wArgs.indexOf('--prompt') + 1], 'Robin, Fairview')
  assert.equal(wArgs[wArgs.indexOf('-t') + 1], '3')
})
